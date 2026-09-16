// FRACTAL: implements F1 | component C11
import { inflateRawSync, inflateSync } from 'node:zlib';

/**
 * DOCX text extraction.
 *
 * WHY there is no zip dependency: a .docx is a zip whose one interesting member is
 * `word/document.xml`, and reading one named member out of a zip is a central directory
 * walk plus `zlib.inflateRaw` — both of which Node already has. A dependency would buy
 * encryption, spanning and streaming, none of which a Word document a learner exports
 * uses. This was the "cheap to add" that made DOCX worth adding at all.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const MAX_MEMBER_BYTES = 64 * 1024 * 1024;
/**
 * WHY there is an archive-wide budget on top of the per-member one: the body parts are an
 * unbounded family (`headerN.xml`, `footerN.xml`), so a 20 MB file can legally declare
 * hundreds of them, each under the member cap and each inflating to something huge. Every
 * inflated part is held until the final join, so the ceiling that matters is the sum, not
 * the largest. A real syllabus is a few hundred KB of XML; 64 MB of markup across the whole
 * document is already far past anything Word writes.
 */
const MAX_TOTAL_INFLATED_BYTES = 64 * 1024 * 1024;
/** Word writes one header and footer per section; a document with dozens is not a document. */
const MAX_BODY_PARTS = 64;
/** Every central directory record is at least 46 bytes, so a larger count is a lie. */
const MIN_CENTRAL_RECORD_BYTES = 46;

/** The one message any of these limits fails with, so the caller sees a size refusal and
 *  not a zlib internal. `extractSource` turns it into the "we could not read that" copy. */
export const DOCX_TOO_LARGE = 'document is too large to read';

type ZipEntry = { name: string; method: number; offset: number; compressedSize: number };

function findEndOfCentralDirectory(buf: Buffer): number {
  // The comment field is variable-length, so the record is found by scanning back from
  // the end. 22 bytes is the record with no comment; 0xffff is the longest comment.
  const earliest = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= earliest; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

function readCentralDirectory(buf: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  // The count is a raw uint16 the archive chose; up to 65535 entries can be declared with
  // no bytes behind them at all. Refuse before the loop allocates for entries that cannot fit.
  if (count * MIN_CENTRAL_RECORD_BYTES > buf.length) throw new Error(DOCX_TOO_LARGE);
  let cursor = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break;
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const offset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    entries.push({ name, method, offset, compressedSize });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Bytes left in the archive-wide inflation budget, decremented as parts are read. */
type Budget = { remaining: number };

function readMember(buf: Buffer, entry: ZipEntry, budget: Budget): Buffer {
  const header = entry.offset;
  if (header + 30 > buf.length || buf.readUInt32LE(header) !== 0x04034b50) {
    throw new Error('zip member header is not where the directory said');
  }
  const nameLength = buf.readUInt16LE(header + 26);
  const extraLength = buf.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  // WHY the directory's size and not the local header's: the local header is allowed to
  // carry zeros and defer the sizes to a data descriptor after the payload, which the
  // central directory has already resolved.
  const end = entry.compressedSize > 0 ? start + entry.compressedSize : buf.length;
  const slice = buf.subarray(start, Math.min(end, buf.length));
  if (slice.length > MAX_MEMBER_BYTES) throw new Error('zip member is implausibly large');
  // The cap handed to zlib is whatever the archive has left, so a bomb stops inflating at
  // the budget rather than after materializing a member's worth of memory past it.
  const cap = Math.min(MAX_MEMBER_BYTES, budget.remaining);
  let out: Buffer;
  if (entry.method === 0) {
    if (slice.length > cap) throw new Error(DOCX_TOO_LARGE);
    out = Buffer.from(slice);
  } else if (entry.method === 8) {
    try {
      out = inflateRawSync(slice, { maxOutputLength: cap });
    } catch (cause) {
      // zlib's own ERR_BUFFER_TOO_LARGE says nothing about which limit was hit.
      if ((cause as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new Error(DOCX_TOO_LARGE);
      }
      throw cause;
    }
  } else {
    throw new Error(`unsupported zip compression method ${entry.method}`);
  }
  budget.remaining -= out.length;
  return out;
}

/** WHY every part and not just document.xml: headers, footnotes and text boxes are
 *  separate parts, and a syllabus that puts its unit list in a text box is common. */
const BODY_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

function xmlToText(xml: string): string {
  return (
    xml
      // Word's own break elements, before the tags around them are dropped.
      .replace(/<w:tab\b[^>]*\/?>/g, '\t')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:br\b[^>]*\/?>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
      .replace(/&amp;/g, '&')
  );
}

export function extractDocxText(bytes: Uint8Array): string {
  let buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // A .docx that has been gzipped in transit is still the document the learner meant.
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    buf = inflateSync(buf, { maxOutputLength: MAX_MEMBER_BYTES });
  }
  const entries = readCentralDirectory(buf);
  const parts = entries
    .filter((e) => BODY_PARTS.test(e.name))
    .sort((a, b) => (a.name === 'word/document.xml' ? -1 : b.name === 'word/document.xml' ? 1 : a.name.localeCompare(b.name)));
  if (parts.length === 0) throw new Error('archive holds no Word document part');
  if (parts.length > MAX_BODY_PARTS) throw new Error(DOCX_TOO_LARGE);
  const budget: Budget = { remaining: MAX_TOTAL_INFLATED_BYTES };
  const texts: string[] = [];
  // A loop and not a map: the budget is checked as each part inflates, so an archive of
  // hundreds of bombs aborts on the first one past the ceiling rather than at the end.
  for (const part of parts) {
    texts.push(xmlToText(readMember(buf, part, budget).toString('utf8')));
  }
  return texts.join('\n');
}
