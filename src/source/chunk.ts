// FRACTAL: implements F2 | component C11
import type { SourceUnit } from '@/shapes';
import { sectionsOf } from '@/source/outline';

/**
 * How long material is made to fit a session's context.
 *
 * WHY chunking and not truncation: a learner may bring a 600-page textbook, and the first
 * 20,000 characters of one is the table of contents and the marking policy — the least
 * useful slice there is. Nothing here reads the whole document to a model. Two bounded
 * VIEWS are derived from it instead, each built for the session that reads it:
 *
 *   - the scope digest (research): every unit heading the material names, in order, each
 *     with the first line or two under it, until the budget is spent. Scope and sequence
 *     is what the outline pass needs, and headings are almost pure signal.
 *   - module excerpts (authoring): the chunks that overlap the module's own title and
 *     objectives, in document order, each labelled with the section it came from. What a
 *     lesson needs is the passage about ITS idea, not the book.
 *
 * Both report what they left out rather than trimming in silence, and the report goes
 * into the prompt so the session knows it is reading an extract.
 */

export const MAX_CHUNK_CHARS = 4_000;
export const SCOPE_DIGEST_CHARS = 12_000;
export const MODULE_EXCERPT_CHARS = 6_000;
const UNIT_LEAD_CHARS = 240;

export type SourceChunk = {
  /** The section this came from, as the material labelled it. */
  label: string;
  text: string;
  /** Position in the document, so excerpts can be re-ordered back into reading order. */
  ordinal: number;
};

function splitLong(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let current = '';
  for (const paragraph of text.split(/\n{2,}/)) {
    if (current.length > 0 && current.length + paragraph.length + 2 > limit) {
      out.push(current);
      current = '';
    }
    // A single paragraph longer than the whole budget is cut on a hard boundary; there
    // is nothing softer left to cut on.
    if (paragraph.length > limit) {
      for (let i = 0; i < paragraph.length; i += limit) out.push(paragraph.slice(i, i + limit));
      continue;
    }
    current = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}

/** Structural first: cut on the headings the material itself uses, then on paragraphs. */
export function chunkDocument(text: string, documentLabel: string): SourceChunk[] {
  const lines = text.split('\n');
  const sections = sectionsOf(text);
  const bounds: { label: string; from: number; to: number }[] = [];

  if (sections.length === 0 || sections[0].line > 0) {
    bounds.push({ label: documentLabel, from: 0, to: sections.length === 0 ? lines.length : sections[0].line });
  }
  sections.forEach((section, i) => {
    const to = i + 1 < sections.length ? sections[i + 1].line : lines.length;
    bounds.push({ label: `${documentLabel} · ${section.label === section.title ? section.label : `${section.label}: ${section.title}`}`, from: section.line, to });
  });

  const chunks: SourceChunk[] = [];
  for (const bound of bounds) {
    const body = lines.slice(bound.from, bound.to).join('\n').replace(/\f/g, '\n').trim();
    if (body.length === 0) continue;
    for (const piece of splitLong(body, MAX_CHUNK_CHARS)) {
      if (piece.trim().length === 0) continue;
      chunks.push({ label: bound.label.slice(0, 200), text: piece.trim(), ordinal: chunks.length });
    }
  }
  return chunks;
}

export type BoundedView = {
  blocks: { label: string; text: string }[];
  /** How many chunks the budget kept out. Never zero and silent. */
  omitted: number;
};

/**
 * The whole of the material's scope and sequence, none of its bulk: every unit it names,
 * each with the first couple of lines under it, until the budget runs out.
 */
export function scopeDigest(
  units: SourceUnit[],
  chunks: SourceChunk[],
  budget: number = SCOPE_DIGEST_CHARS,
): BoundedView {
  const blocks: { label: string; text: string }[] = [];
  let spent = 0;
  let omitted = 0;

  if (units.length > 0) {
    const list = units.map((u) => (u.label === u.title ? u.title : `${u.label}: ${u.title}`)).join('\n');
    const trimmed = list.slice(0, Math.min(budget, 6_000));
    blocks.push({ label: 'The units this material names, in its own order', text: trimmed });
    spent += trimmed.length;
  }

  for (const chunk of chunks) {
    const lead = chunk.text.slice(0, UNIT_LEAD_CHARS).trim();
    if (lead.length === 0) continue;
    if (spent + lead.length > budget) {
      omitted += 1;
      continue;
    }
    blocks.push({ label: chunk.label, text: lead });
    spent += lead.length;
  }
  return { blocks, omitted };
}

const QUERY_STOPWORDS = new Set(['and', 'the', 'for', 'with', 'from', 'that', 'this', 'into', 'about', 'your']);

function queryTokens(query: string): string[] {
  return [...new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !QUERY_STOPWORDS.has(w)),
  )];
}

function score(chunk: SourceChunk, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const label = chunk.label.toLowerCase();
  const body = chunk.text.toLowerCase();
  let total = 0;
  for (const token of tokens) {
    // A hit in the heading is what the section is ABOUT; a hit in the body is a mention.
    if (label.includes(token)) total += 5;
    if (body.includes(token)) total += 1;
  }
  return total;
}

/**
 * The passages a single lesson should be written from: the highest-scoring chunks against
 * that lesson's title and objectives, handed back in document order so the session reads
 * them the way the book is written.
 */
export function selectExcerpts(
  chunks: SourceChunk[],
  query: string,
  budget: number = MODULE_EXCERPT_CHARS,
): BoundedView {
  const tokens = queryTokens(query);
  const ranked = chunks
    .map((chunk) => ({ chunk, score: score(chunk, tokens) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.ordinal - b.chunk.ordinal);

  // WHY the fallback: a lesson the app added because the syllabus assumed it — the
  // prerequisite nobody wrote a unit for — matches nothing, and reading the opening of
  // the material is more use to it than reading none of it.
  const pool = ranked.length > 0 ? ranked.map((r) => r.chunk) : chunks.slice(0, 3);

  const taken: SourceChunk[] = [];
  let spent = 0;
  let omitted = 0;
  for (const chunk of pool) {
    if (spent + chunk.text.length > budget) {
      omitted += 1;
      continue;
    }
    taken.push(chunk);
    spent += chunk.text.length;
  }
  omitted += Math.max(0, chunks.length - pool.length);

  return {
    blocks: taken
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((chunk) => ({ label: chunk.label, text: chunk.text })),
    omitted,
  };
}
