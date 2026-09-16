// FRACTAL: implements F2 | component C11
import type { SourceUnit, TopicId } from '@/shapes';
import type { Store } from '@/store/open';
import { log } from '@/core/log';
import { chunkDocument, scopeDigest, selectExcerpts, type SourceChunk } from '@/source/chunk';
import { extractUnits, keyTerms } from '@/source/outline';
import { readSourceText } from '@/source/store';

/**
 * A topic's own material, in the shape F2 reads it.
 *
 * WHY this is a separate layer rather than the documents themselves: what the orchestrator
 * needs is never "the file". Research needs the scope and sequence the material declares;
 * authoring needs the passage about ONE idea. Both are derived here, bounded here, and
 * report what they left out here, so no session is ever handed a book and a hope.
 */
export type TopicMaterial = {
  documentCount: number;
  /** Every unit the material names, across all its documents, in reading order. */
  units: SourceUnit[];
  /** The words the material uses for its own ideas — the vocabulary the lessons adopt. */
  keyTerms: string[];
  chunks: SourceChunk[];
  /** True when any document was longer than the store's cap and was recorded as clipped. */
  truncated: boolean;
};

/** The bounded view of the material that goes into one prompt. Never the whole thing. */
export type MaterialBrief = {
  units: { label: string; title: string }[];
  keyTerms: string[];
  blocks: { label: string; text: string }[];
  omitted: number;
  truncated: boolean;
  documentCount: number;
};

const MAX_BRIEF_UNITS = 40;
const MAX_BRIEF_TERMS = 24;

/**
 * WHY a memo: one authoring pass writes up to a prep window of lessons concurrently, and
 * every one of them wants an excerpt from the same material. Re-reading and re-chunking a
 * textbook per lesson is the same work done ten times over for an identical answer — the
 * material of a topic never changes after intake, so the parse is done once.
 */
const MEMO = new Map<string, TopicMaterial | null>();
const MAX_MEMO = 32;

export function resetMaterialCache(): void {
  MEMO.clear();
}

function build(store: Store, dataRoot: string, topicId: TopicId): TopicMaterial | null {
  const documents = store.sources.listFor(topicId);
  if (documents.length === 0) return null;

  const chunks: SourceChunk[] = [];
  const units: SourceUnit[] = [];
  const seenUnits = new Set<string>();
  const corpus: string[] = [];
  let truncated = false;
  let read = 0;

  for (const doc of documents) {
    const text = readSourceText(dataRoot, topicId, doc.id);
    if (text === null || text.trim().length === 0) {
      // The index says there is material and the disk disagrees. The course still runs;
      // it runs on the documents that ARE readable, which is what the learner would want.
      log({ level: 'warn', event: 'source-document-missing', component: 'C11', topicId, sourceId: doc.id });
      continue;
    }
    read += 1;
    if (doc.truncated) truncated = true;
    corpus.push(text);
    // The units recorded at intake are what the learner saw us infer; re-deriving them
    // here would let the two disagree. Only a document with none recorded is re-read.
    for (const unit of doc.units.length > 0 ? doc.units : extractUnits(text)) {
      const key = unit.title.toLowerCase();
      if (seenUnits.has(key)) continue;
      seenUnits.add(key);
      units.push(unit);
    }
    for (const chunk of chunkDocument(text, doc.filename)) {
      chunks.push({ ...chunk, ordinal: chunks.length });
    }
  }

  if (read === 0) return null;
  return { documentCount: read, units, keyTerms: keyTerms(corpus.join('\n\n'), units), chunks, truncated };
}

export function loadMaterial(store: Store, dataRoot: string, topicId: TopicId): TopicMaterial | null {
  const key = `${dataRoot}::${topicId}`;
  const cached = MEMO.get(key);
  if (cached !== undefined) return cached;
  const built = build(store, dataRoot, topicId);
  if (MEMO.size >= MAX_MEMO) {
    const oldest = MEMO.keys().next();
    if (!oldest.done) MEMO.delete(oldest.value);
  }
  MEMO.set(key, built);
  return built;
}

function trim(material: TopicMaterial, view: { blocks: { label: string; text: string }[]; omitted: number }): MaterialBrief {
  return {
    units: material.units.slice(0, MAX_BRIEF_UNITS),
    keyTerms: material.keyTerms.slice(0, MAX_BRIEF_TERMS),
    blocks: view.blocks,
    omitted: view.omitted,
    truncated: material.truncated,
    documentCount: material.documentCount,
  };
}

/** What the research session reads: the whole of the scope, none of the bulk. */
export function researchView(material: TopicMaterial): MaterialBrief {
  return trim(material, scopeDigest(material.units, material.chunks));
}

/** What one authoring session reads: the passages about ITS idea, in document order. */
export function moduleView(material: TopicMaterial, query: string): MaterialBrief {
  return trim(material, selectExcerpts(material.chunks, query));
}
