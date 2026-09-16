// FRACTAL: implements F1 | component C11
import { MAX_SOURCE_BYTES, type SourceKind } from '@/shapes';
import { log } from '@/core/log';
import { extractDocxText } from '@/source/docx';
import { extractPdfText } from '@/source/pdf';
import { capSourceText, kindForName, normalizeSourceText, normalizeSourceTextAsync, sniffKind } from '@/source/text';

export type ExtractionFailure =
  | 'unsupported'
  | 'too-large'
  | 'unparseable'
  | 'no-text'
  | 'empty';

export type ExtractionOutcome =
  | { ok: true; kind: SourceKind; text: string; pageCount: number | null; truncated: boolean }
  | { ok: false; reason: ExtractionFailure; message: string };

/**
 * WHY every message names the paste box: a refusal that only says no leaves the learner
 * with a textbook they cannot use and no idea that the app has another way in. Each of
 * these is a dead end plus the door out of it.
 */
export const FAILURE_MESSAGES: Readonly<Record<ExtractionFailure, string>> = {
  unsupported:
    'We can read PDF, Word (.docx), plain text and Markdown. For anything else, paste the text into the box below instead.',
  'too-large': 'That file is bigger than 25 MB. Upload the syllabus or the chapters you need, or paste the text into the box below.',
  unparseable:
    'We could not read that file — it may be damaged, password-protected, or not really the format its name says. Try exporting it again, or paste the text into the box below.',
  'no-text':
    'That PDF is a picture of a page, not text — a scan. We do not run OCR here, so there is nothing for us to read. Paste the text into the box below instead, or upload a version with selectable text.',
  empty: 'There was no text in that file. Paste the material into the box below instead.',
};

function failed(reason: ExtractionFailure): ExtractionOutcome {
  return { ok: false, reason, message: FAILURE_MESSAGES[reason] };
}

/** Text that is nothing but whitespace, page breaks and stray punctuation is no text. */
function hasRealText(text: string): boolean {
  return /[A-Za-z0-9\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff]/.test(text);
}

/**
 * The one door every upload comes through. It decides what the file IS from its bytes
 * first and its name second, reads it in this process, and returns either usable text or
 * the specific reason there is none — never an empty extraction dressed up as a success.
 */
export async function extractSource(
  bytes: Uint8Array,
  filename: string,
  mimeType: string | null,
): Promise<ExtractionOutcome> {
  if (bytes.byteLength === 0) return failed('empty');
  if (bytes.byteLength > MAX_SOURCE_BYTES) return failed('too-large');

  const sniffed = sniffKind(bytes);
  const named = kindForName(filename, mimeType);
  // The bytes win, except that a zip could be a .docx or could be anything, so it is only
  // trusted as a document when the name agrees.
  const kind: SourceKind | null =
    sniffed === 'pdf' ? 'pdf' : sniffed === 'docx' ? (named === 'docx' ? 'docx' : null) : named;
  if (kind === null || kind === 'pasted') return failed('unsupported');
  // A file whose name says PDF but whose bytes are not one is not a PDF we can read.
  if (kind === 'pdf' && sniffed !== 'pdf') return failed('unparseable');
  if (kind === 'docx' && sniffed !== 'docx') return failed('unparseable');

  let raw: string;
  let pageCount: number | null = null;
  // Set when the READ stopped short (page cap or character budget), as opposed to when the
  // extracted text was cut afterwards. Either way the learner is told.
  let readTruncated = false;
  try {
    if (kind === 'pdf') {
      const read = await extractPdfText(bytes);
      raw = read.text;
      pageCount = read.pageCount;
      readTruncated = read.truncated;
    } else if (kind === 'docx') {
      raw = extractDocxText(bytes);
    } else {
      raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
  } catch (cause) {
    log({
      level: 'warn',
      event: 'source-extract-failed',
      component: 'C11',
      kind,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
    return failed('unparseable');
  }

  const normalized = await normalizeSourceTextAsync(raw);
  if (!hasRealText(normalized)) {
    // WHY the two answers differ: a PDF with no text is the scanner case, and saying so
    // is the difference between "your file is broken" (it is not) and "this one is
    // pictures". Any other format that came back empty simply had nothing in it.
    return failed(kind === 'pdf' ? 'no-text' : 'empty');
  }

  const capped = capSourceText(normalized);
  return { ok: true, kind, text: capped.text, pageCount, truncated: capped.truncated || readTruncated };
}

/**
 * The paste path. Same normalization, same cap, no format to get wrong.
 *
 * Synchronous, unlike `extractSource`, because the paste box is capped at
 * `MAX_SOURCE_CHARS` where it is read — there is no equivalent of a 25 MB file whose text
 * nobody has counted yet, so there is nothing here to yield the loop for.
 */
export function extractPastedSource(raw: string): ExtractionOutcome {
  const normalized = normalizeSourceText(raw);
  if (!hasRealText(normalized)) return failed('empty');
  const capped = capSourceText(normalized);
  return { ok: true, kind: 'pasted', text: capped.text, pageCount: null, truncated: capped.truncated };
}
