// FRACTAL: covers F2 | type unit
import { describe, expect, it } from 'vitest';
import {
  MAX_CHUNK_CHARS,
  chunkDocument,
  scopeDigest,
  selectExcerpts,
  type SourceChunk,
} from '@/source/chunk';
import { extractUnits } from '@/source/outline';

const BOOK = [
  'Information Theory',
  'A preface that belongs to no unit.',
  '',
  'Unit 1: Probability review',
  'Random variables, expectation and independence.',
  'Everything in this course rests on these three ideas.',
  '',
  'Unit 2: Entropy',
  'Entropy measures the average surprise of a source.',
  'It is the number of bits a perfect code would spend per symbol.',
  '',
  'Unit 3: Channel capacity',
  'A noisy channel still has a rate below which reliable communication is possible.',
].join('\n');

describe('cutting a document into chunks', () => {
  it('cuts on the headings the material itself uses', () => {
    const chunks = chunkDocument(BOOK, 'book.pdf');
    expect(chunks.map((c) => c.label)).toEqual([
      'book.pdf',
      'book.pdf · Unit 1: Probability review',
      'book.pdf · Unit 2: Entropy',
      'book.pdf · Unit 3: Channel capacity',
    ]);
    // The material before the first heading is kept, not thrown away with the front matter.
    expect(chunks[0].text).toContain('A preface that belongs to no unit.');
    expect(chunks[1].text).toContain('Random variables');
  });

  it('numbers chunks in reading order, so excerpts can be put back in the book’s order', () => {
    expect(chunkDocument(BOOK, 'book.pdf').map((c) => c.ordinal)).toEqual([0, 1, 2, 3]);
  });

  it('falls back to paragraph breaks when one section is longer than a chunk', () => {
    const paragraph = 'Sentences about one idea. '.repeat(60); // ~1,560 chars
    const long = ['Unit 1: A long unit', ...Array.from({ length: 5 }, () => paragraph)].join('\n\n');
    const chunks = chunkDocument(long, 'long.pdf');
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  });

  it('cuts a single paragraph with no softer boundary left, rather than exceeding the chunk', () => {
    const wall = 'x'.repeat(MAX_CHUNK_CHARS * 3);
    const chunks = chunkDocument(wall, 'wall.txt');
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  });

  it('produces nothing from an empty document rather than one empty chunk', () => {
    expect(chunkDocument('   \n\n  ', 'blank.txt')).toEqual([]);
  });
});

describe('the scope digest — what the research session reads', () => {
  const units = extractUnits(BOOK);
  const chunks = chunkDocument(BOOK, 'book.pdf');

  it('leads with every unit the material names, in the material’s own order', () => {
    const view = scopeDigest(units, chunks);
    expect(view.blocks[0].text).toBe(
      ['Unit 1: Probability review', 'Unit 2: Entropy', 'Unit 3: Channel capacity'].join('\n'),
    );
  });

  it('carries a lead from each section, not the whole of any of them', () => {
    const view = scopeDigest(units, chunks);
    const labels = view.blocks.map((b) => b.label);
    expect(labels).toContain('book.pdf · Unit 2: Entropy');
    const entropy = view.blocks.find((b) => b.label === 'book.pdf · Unit 2: Entropy');
    expect(entropy?.text).toContain('Entropy measures the average surprise');
    // The lead is capped well below a chunk; this section is short enough to survive whole.
    expect(entropy?.text.length).toBeLessThan(MAX_CHUNK_CHARS);
  });

  it('reports what the budget kept out instead of trimming in silence', () => {
    const tight = scopeDigest(units, chunks, 120);
    expect(tight.omitted).toBeGreaterThan(0);
    const whole = scopeDigest(units, chunks);
    expect(whole.omitted).toBe(0);
  });

  it('still says what the units are when the budget only fits the list', () => {
    const view = scopeDigest(units, chunks, 200);
    expect(view.blocks[0].text).toContain('Unit 3: Channel capacity');
  });
});

describe('module excerpts — what one authoring session reads', () => {
  const chunks = chunkDocument(BOOK, 'book.pdf');

  it('picks the passages about the module’s own idea, not the book', () => {
    const view = selectExcerpts(chunks, 'Entropy of a discrete source');
    expect(view.blocks[0].label).toBe('book.pdf · Unit 2: Entropy');
    expect(view.blocks.map((b) => b.text).join()).toContain('average surprise');
  });

  it('returns what it picked in document order, however it was scored', () => {
    const view = selectExcerpts(chunks, 'channel capacity and probability review');
    const labels = view.blocks.map((b) => b.label);
    expect(labels.indexOf('book.pdf · Unit 1: Probability review')).toBeLessThan(
      labels.indexOf('book.pdf · Unit 3: Channel capacity'),
    );
  });

  it('gives the opening of the material to a module that matches nothing', () => {
    // The prerequisite the app added because the syllabus assumed it. Reading the front of
    // the book is more use to it than reading none of it.
    const view = selectExcerpts(chunks, 'Ancient Sumerian pottery');
    expect(view.blocks.length).toBeGreaterThan(0);
    expect(view.blocks[0].label).toBe('book.pdf');
  });

  it('reports what the budget kept out', () => {
    const view = selectExcerpts(chunks, 'entropy probability channel', 80);
    expect(view.omitted).toBeGreaterThan(0);
  });

  it('never returns a block longer than a chunk, whatever the query', () => {
    const big: SourceChunk[] = chunkDocument('y'.repeat(MAX_CHUNK_CHARS * 2), 'big.txt');
    for (const block of selectExcerpts(big, 'y').blocks) {
      expect(block.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
  });
});
