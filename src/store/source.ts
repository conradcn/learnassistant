// FRACTAL: implements F1 | component C1
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  sourceDocumentSchema,
  sourceIdSchema,
  type SourceDocument,
  type SourceId,
  type SourceKind,
  type SourceUnit,
  type TopicId,
} from '@/shapes';
import { log } from '@/core/log';

export type NewSourceDocument = {
  id: SourceId;
  topicId: TopicId;
  filename: string;
  kind: SourceKind;
  byteSize: number;
  charCount: number;
  pageCount: number | null;
  truncated: boolean;
  units: SourceUnit[];
};

export type SourcesRepo = {
  add(input: NewSourceDocument): SourceDocument;
  listFor(topicId: TopicId): SourceDocument[];
};

type SourceRow = {
  id: string;
  topic_id: string;
  filename: string;
  kind: string;
  byte_size: number;
  char_count: number;
  page_count: number | null;
  truncated: number;
  units_json: string;
  added_at: string;
};

/** The same alphabet and width every other minted id in this app uses. */
export function newSourceId(): SourceId {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(16);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return sourceIdSchema.parse(`sd_${out}`);
}

function nowIso(): string {
  return new Date().toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');
}

/**
 * WHY a row that fails to parse is dropped rather than degrading the topic: source
 * material SUPPLEMENTS the intake, so a course whose syllabus index went bad is a course
 * that researches from the subject and level — exactly the path a learner who uploaded
 * nothing takes. Losing the constraint is a smaller harm than refusing the topic, and it
 * is logged loudly enough to find.
 */
function rowToDocument(row: SourceRow): SourceDocument | null {
  let units: unknown;
  try {
    units = JSON.parse(row.units_json);
  } catch {
    units = null;
  }
  const parsed = sourceDocumentSchema.safeParse({
    id: row.id,
    topicId: row.topic_id,
    filename: row.filename,
    kind: row.kind,
    byteSize: row.byte_size,
    charCount: row.char_count,
    pageCount: row.page_count,
    truncated: row.truncated === 1,
    units: Array.isArray(units) ? units : [],
    addedAt: row.added_at,
  });
  if (!parsed.success) {
    log({ level: 'warn', event: 'source-row-unreadable', component: 'C1', sourceId: row.id });
    return null;
  }
  return parsed.data;
}

export function createSourcesRepo(db: Database.Database): SourcesRepo {
  const insertStmt = db.prepare(`
    INSERT INTO source_documents (id, topic_id, filename, kind, byte_size, char_count, page_count, truncated, units_json, added_at)
    VALUES (@id, @topicId, @filename, @kind, @byteSize, @charCount, @pageCount, @truncated, @unitsJson, @addedAt)
  `);
  // Ordered by insertion time so the material reads in the order the learner added it —
  // a course's own volumes are usually uploaded in the order they are studied. The rowid
  // breaks the tie: attaching happens in a loop, so several documents share a millisecond,
  // and ordering those by their random ids would shuffle a learner's volumes.
  const listStmt = db.prepare('SELECT * FROM source_documents WHERE topic_id = ? ORDER BY added_at ASC, rowid ASC');

  return {
    add(input: NewSourceDocument): SourceDocument {
      const doc: SourceDocument = sourceDocumentSchema.parse({
        ...input,
        units: input.units.slice(0, 60),
        addedAt: nowIso(),
      });
      insertStmt.run({
        id: doc.id,
        topicId: doc.topicId,
        filename: doc.filename,
        kind: doc.kind,
        byteSize: doc.byteSize,
        charCount: doc.charCount,
        pageCount: doc.pageCount,
        truncated: doc.truncated ? 1 : 0,
        unitsJson: JSON.stringify(doc.units),
        addedAt: doc.addedAt,
      });
      return doc;
    },

    listFor(topicId: TopicId): SourceDocument[] {
      const rows = listStmt.all(topicId) as SourceRow[];
      return rows.map(rowToDocument).filter((d): d is SourceDocument => d !== null);
    },
  };
}
