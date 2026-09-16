// FRACTAL: covers F1 | type unit
import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { exampleStagedSource, MAX_SOURCE_BYTES, MAX_SOURCE_CHARS, MAX_SOURCE_PAGES } from '@/shapes';
import { extractPastedSource, extractSource, FAILURE_MESSAGES } from '@/source/extract';
import { extractUnits } from '@/source/outline';
import { oversizeNote } from '@/ui/source-material';
import { extractPdfText } from '@/source/pdf';
import { scannedPdf, textPdf } from '@/source/pdf.testing';
import { kindForName, normalizeSourceText, normalizeSourceTextAsync, safeFilename, sniffKind } from '@/source/text';

const SYLLABUS_PAGE_ONE = [
  'PHYS 340: Statistical Mechanics',
  'Autumn term. Prerequisite: PHYS 210.',
  'Unit 1: Microstates and macrostates',
  'Unit 2: The Boltzmann distribution',
];
const SYLLABUS_PAGE_TWO = ['Unit 3: Partition functions', 'Unit 4: Free energy'];

/** A .docx is a zip with one interesting member; this builds the smallest real one. */
function docxWithParagraphs(paragraphs: string[]): Buffer {
  const xml =
    '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
    paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('') +
    '</w:body></w:document>';
  const name = Buffer.from('word/document.xml', 'utf8');
  const payload = deflateRawSync(Buffer.from(xml, 'utf8'));

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(Buffer.byteLength(xml), 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(Buffer.byteLength(xml), 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);

  const centralOffset = local.length + name.length + payload.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([local, name, payload, central, name, eocd]);
}

/** A zip of arbitrary named XML parts — how a hostile .docx declares an unbounded family
 *  of `word/headerN.xml` members that each inflate to far more than they cost to ship. */
function docxOfParts(parts: { name: string; xml: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name, 'utf8');
    const payload = deflateRawSync(Buffer.from(part.xml, 'utf8'));

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(Buffer.byteLength(part.xml), 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(Buffer.byteLength(part.xml), 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, payload);
    centrals.push(central, name);
    offset += local.length + name.length + payload.length;
  }

  const body = Buffer.concat(locals);
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(parts.length, 8);
  eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(body.length, 16);

  return Buffer.concat([body, directory, eocd]);
}

/** One body part that inflates to `megabytes` of markup out of a few KB on the wire. */
function fatPart(name: string, megabytes: number): { name: string; xml: string } {
  const filler = 'a'.repeat(1024 * 1024 * megabytes);
  return { name, xml: `<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>${filler}</w:t></w:r></w:p></w:body></w:document>` };
}

describe('source extraction', () => {
  it('reads the text out of a PDF, page by page, without leaving the process', async () => {
    const pdf = textPdf([SYLLABUS_PAGE_ONE, SYLLABUS_PAGE_TWO]);
    const outcome = await extractSource(pdf, 'phys340-syllabus.pdf', 'application/pdf');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.kind).toBe('pdf');
    expect(outcome.pageCount).toBe(2);
    expect(outcome.truncated).toBe(false);
    for (const line of [...SYLLABUS_PAGE_ONE, ...SYLLABUS_PAGE_TWO]) {
      expect(outcome.text).toContain(line);
    }
  });

  it('keeps a unit that opens a new page readable as a heading of its own', async () => {
    const outcome = await extractSource(
      textPdf([SYLLABUS_PAGE_ONE, SYLLABUS_PAGE_TWO]),
      'phys340-syllabus.pdf',
      'application/pdf',
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // A PDF reader emits no newline at a page boundary, so without the break standing on
    // its own line "Unit 3" would arrive glued to the last sentence of page two and every
    // unit after a page turn would be invisible to the matcher.
    expect(outcome.text.split('\n')).toContain('Unit 3: Partition functions');
    expect(extractUnits(outcome.text).map((u) => u.title)).toEqual([
      'Microstates and macrostates',
      'The Boltzmann distribution',
      'Partition functions',
      'Free energy',
    ]);
  });

  it('refuses a scanned PDF as a scan, and points at the paste box', async () => {
    const outcome = await extractSource(scannedPdf(), 'scan.pdf', 'application/pdf');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('no-text');
    expect(outcome.message).toBe(FAILURE_MESSAGES['no-text']);
    expect(outcome.message).toMatch(/paste/i);
  });

  it('refuses an unreadable PDF as unreadable rather than as an empty one', async () => {
    const damaged = Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.from('not a pdf body at all')]);
    const outcome = await extractSource(damaged, 'broken.pdf', 'application/pdf');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('unparseable');
    expect(outcome.message).toMatch(/paste/i);
  });

  it('refuses a file whose name claims PDF but whose bytes do not', async () => {
    const outcome = await extractSource(Buffer.from('Unit 1: not really a pdf'), 'liar.pdf', 'application/pdf');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('unparseable');
  });

  it('reads plain text and Markdown as themselves', async () => {
    const text = await extractSource(Buffer.from('Unit 1: Limits\nUnit 2: Derivatives\n'), 'plan.txt', 'text/plain');
    const markdown = await extractSource(Buffer.from('# Course\n\n## Unit 1: Limits\n'), 'plan.md', null);

    expect(text.ok && text.kind).toBe('text');
    expect(markdown.ok && markdown.kind).toBe('markdown');
    expect(text.ok && text.pageCount).toBe(null);
  });

  it('reads the paragraphs out of a DOCX', async () => {
    const docx = docxWithParagraphs(['MATH 221 Syllabus', 'Unit 1: Vectors', 'Unit 2: Matrices']);
    const outcome = await extractSource(
      docx,
      'syllabus.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.kind).toBe('docx');
    expect(outcome.text).toContain('Unit 2: Matrices');
  });

  it('refuses a DOCX whose parts would inflate past the archive-wide budget, before reading them all', async () => {
    // 32 x 6 MB is 192 MB of markup shipped in a few hundred KB — under the per-member cap
    // and under the part count, so only the cumulative budget can stop it.
    const docx = docxOfParts(Array.from({ length: 32 }, (_, i) => fatPart(`word/header${i + 1}.xml`, 6)));
    expect(docx.byteLength).toBeLessThan(MAX_SOURCE_BYTES);

    global.gc?.();
    const before = process.memoryUsage().rss;
    const outcome = await extractSource(
      docx,
      'syllabus.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    const grew = process.memoryUsage().rss - before;

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('unparseable');
    expect(outcome.message).toBe(FAILURE_MESSAGES.unparseable);
    // The 64 MB budget plus the strings made from it, still nowhere near the 192 MB the
    // archive asked for. Without the budget this holds every part at once.
    expect(grew).toBeLessThan(160 * 1024 * 1024);
  });

  it('refuses a DOCX declaring more body parts than a document has, without inflating any', async () => {
    const docx = docxOfParts(
      Array.from({ length: 200 }, (_, i) => ({
        name: `word/header${i + 1}.xml`,
        xml: '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>',
      })),
    );
    const outcome = await extractSource(
      docx,
      'syllabus.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('unparseable');
  });

  it('refuses a DOCX whose directory claims more entries than the file has room for', async () => {
    const docx = docxWithParagraphs(['MATH 221 Syllabus']);
    const eocd = docx.length - 22;
    docx.writeUInt16LE(0xffff, eocd + 10);
    const outcome = await extractSource(
      docx,
      'syllabus.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('unparseable');
  });

  it('refuses a format it cannot read, naming the ones it can', async () => {
    const outcome = await extractSource(Buffer.from([0x00, 0x01, 0x02, 0x03]), 'notes.pages', 'application/octet-stream');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('unsupported');
    expect(outcome.message).toMatch(/PDF/);
  });


  it('stops at the page cap on a document longer than we read, and says so', async () => {
    // Two pages past the ceiling, so "stopped at the cap" and "stopped at the end" cannot
    // be the same answer.
    const pages = Array.from({ length: MAX_SOURCE_PAGES + 2 }, (_v, i) => [`Page ${i + 1} of the book`]);
    const outcome = await extractSource(textPdf(pages), 'very-long-textbook.pdf', 'application/pdf');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.pageCount).toBe(MAX_SOURCE_PAGES);
    expect(outcome.text).toContain(`Page ${MAX_SOURCE_PAGES} of the book`);
    expect(outcome.text).not.toContain(`Page ${MAX_SOURCE_PAGES + 1} of the book`);
    // Never silently: the flag is what the intake form turns into a note the learner reads.
    expect(outcome.truncated).toBe(true);
    expect(oversizeNote([{ ...exampleStagedSource, filename: 'very-long-textbook.pdf', truncated: true }])).toContain(
      'very-long-textbook.pdf is longer than one course',
    );
  }, 60_000);

  it('stops on the character budget as the pages accumulate, not after reading them all', async () => {
    const pages = Array.from({ length: 40 }, (_v, i) => [`Page ${i + 1}`, 'x'.repeat(60)]);
    // The real budget needs a fixture the size of a book to reach; the behaviour under test
    // is the same at any budget, so this one is small enough to assert on.
    const read = await extractPdfText(textPdf(pages), { maxPages: 40, maxChars: 300 });

    expect(read.truncated).toBe(true);
    expect(read.pageCount).toBeGreaterThan(0);
    expect(read.pageCount).toBeLessThan(40);
    expect(read.text).not.toContain('Page 40');
  }, 60_000);

  it('refuses an empty upload', async () => {
    const outcome = await extractSource(new Uint8Array(0), 'nothing.txt', 'text/plain');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('empty');
  });

  it('takes pasted text on the same terms as a file', () => {
    const outcome = extractPastedSource('Unit 1: Limits\r\nUnit 2: Derivatives');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.kind).toBe('pasted');
    expect(outcome.text).toBe('Unit 1: Limits\nUnit 2: Derivatives');
  });

  it('refuses pasted whitespace', () => {
    expect(extractPastedSource('   \n\n  ').ok).toBe(false);
  });
});

describe('source text handling', () => {
  it('joins a word a PDF broke across a line', () => {
    expect(normalizeSourceText('informa-\ntion theory')).toBe('information theory');
  });

  it('keeps a hyphenated compound that was not a line break', () => {
    expect(normalizeSourceText('well-regarded')).toBe('well-regarded');
  });

  it('preserves the page break and gives it a line of its own', () => {
    expect(normalizeSourceText('end of page one.\fUnit 3: Partition functions')).toBe(
      'end of page one.\n\f\nUnit 3: Partition functions',
    );
  });

it('normalizes the same text whether it yields the loop or not', async () => {
    const raw = 'Unit 1: Limits\r\n\r\n\r\n  trailing  \finforma-\ntion — “quoted” here\n';
    await expect(normalizeSourceTextAsync(raw)).resolves.toBe(normalizeSourceText(raw));
  });

  it('gives the event loop a turn while normalizing a whole upload', async () => {
    // A 2M-character document is the largest input this path takes. Done in one pass it is
    // hundreds of milliseconds in which the UI and the generation stream cannot be served,
    // so what is asserted here is that something else got to run at all.
    const raw = `${'lorem ipsum dolor sit amet '.repeat(4)}\n`.repeat(20_000);
    expect(raw.length).toBeGreaterThan(MAX_SOURCE_CHARS);

    let ticks = 0;
    let timer: ReturnType<typeof setImmediate>;
    const tick = (): void => {
      ticks += 1;
      timer = setImmediate(tick);
    };
    timer = setImmediate(tick);
    try {
      await normalizeSourceTextAsync(raw);
    } finally {
      clearImmediate(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });

  it('strips a path and anything unsafe out of an uploaded name', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('C:\\Users\\me\\syllabus (final).pdf')).toBe('syllabus _final_.pdf');
    expect(safeFilename('')).toBe('material');
  });

  it('knows a PDF and a zip from their first bytes', () => {
    expect(sniffKind(textPdf([['x']]))).toBe('pdf');
    expect(sniffKind(Buffer.from('plain text'))).toBe(null);
    expect(kindForName('a.MD', null)).toBe('markdown');
  });
});
