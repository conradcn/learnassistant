// FRACTAL: implements F5, F1, F13 | component C1
import type Database from 'better-sqlite3';
import {
  isoDateStringSchema,
  moduleIdSchema,
  reviewItemSchema,
  type AssistLevel,
  type ISODateString,
  type ReviewItem,
} from '@/shapes';
import { err } from '@/core/errors';
import type { ReviewGrade } from '@/review/memory';

/**
 * One graded retrieval, as it happened.
 *
 * WHY this exists alongside `ReviewItem`: a `review_items` row is the learner's *current*
 * memory state and is overwritten in place by every grade, so on its own it can answer
 * "when is this next due" and nothing else. An entry here is written once and never
 * changed, and carries the grade — the single input the memory model consumes and the one
 * value `review_items` never stored. `before` is null only for a module's first schedule,
 * which had no prior state.
 */
export type ReviewLogEntry = {
  moduleId: string;
  reviewedAt: ISODateString;
  grade: ReviewGrade;
  before: ReviewMemorySnapshot | null;
  after: ReviewMemorySnapshot;
};

export type ReviewMemorySnapshot = {
  stability: number;
  difficulty: number;
  reps: number;
  intervalDays: number;
};

export function snapshotOf(item: ReviewItem): ReviewMemorySnapshot {
  return {
    stability: item.memory.stability,
    difficulty: item.memory.difficulty,
    reps: item.memory.reps,
    intervalDays: item.intervalDays,
  };
}

export type ReviewsRepo = {
  due(now: ISODateString, limit: number): ReviewItem[];
  /**
   * Persist the new state and, when the write is a graded retrieval, its log entry — in one
   * transaction, so the log can never disagree with the state it describes.
   */
  upsert(item: ReviewItem, logEntry?: ReviewLogEntry): void;
  get(moduleId: string): ReviewItem | null;
  logFor(moduleId: string): ReviewLogEntry[];
};

export type ReviewRow = {
  module_id: string;
  due_at: string;
  interval_days: number;
  lapses: number;
  last_assist_level: number;
  flagged_needs_review: number;
  stability: number;
  difficulty: number;
  reps: number;
  last_reviewed_at: string | null;
};

export function rowToReviewItem(row: ReviewRow): ReviewItem {
  return {
    moduleId: moduleIdSchema.parse(row.module_id),
    dueAt: row.due_at as ISODateString,
    intervalDays: row.interval_days,
    lapses: row.lapses,
    lastAssistLevel: row.last_assist_level as AssistLevel,
    flaggedNeedsReview: row.flagged_needs_review === 1,
    memory: {
      stability: row.stability,
      difficulty: row.difficulty,
      reps: row.reps,
      lastReviewedAt: row.last_reviewed_at === null ? null : isoDateStringSchema.parse(row.last_reviewed_at),
    },
  };
}

export const REVIEW_UPSERT_SQL = `
  INSERT INTO review_items (
    module_id, due_at, interval_days, lapses, last_assist_level, flagged_needs_review,
    stability, difficulty, reps, last_reviewed_at
  )
  VALUES (
    @moduleId, @dueAt, @intervalDays, @lapses, @lastAssistLevel, @flaggedNeedsReview,
    @stability, @difficulty, @reps, @lastReviewedAt
  )
  ON CONFLICT(module_id) DO UPDATE SET
    due_at = excluded.due_at,
    interval_days = excluded.interval_days,
    lapses = excluded.lapses,
    last_assist_level = excluded.last_assist_level,
    flagged_needs_review = excluded.flagged_needs_review,
    stability = excluded.stability,
    difficulty = excluded.difficulty,
    reps = excluded.reps,
    last_reviewed_at = excluded.last_reviewed_at
`;

export const REVIEW_LOG_INSERT_SQL = `
  INSERT INTO review_log (
    module_id, reviewed_at, grade,
    stability_before, difficulty_before, reps_before, interval_days_before,
    stability_after, difficulty_after, reps_after, interval_days_after
  )
  VALUES (
    @moduleId, @reviewedAt, @grade,
    @stabilityBefore, @difficultyBefore, @repsBefore, @intervalDaysBefore,
    @stabilityAfter, @difficultyAfter, @repsAfter, @intervalDaysAfter
  )
`;

export type ReviewLogRow = {
  module_id: string;
  reviewed_at: string;
  grade: string;
  stability_before: number | null;
  difficulty_before: number | null;
  reps_before: number | null;
  interval_days_before: number | null;
  stability_after: number;
  difficulty_after: number;
  reps_after: number;
  interval_days_after: number;
};

export function rowToReviewLogEntry(row: ReviewLogRow): ReviewLogEntry {
  return {
    moduleId: row.module_id,
    reviewedAt: row.reviewed_at as ISODateString,
    grade: row.grade as ReviewGrade,
    before:
      row.stability_before === null
        ? null
        : {
            stability: row.stability_before,
            difficulty: row.difficulty_before as number,
            reps: row.reps_before as number,
            intervalDays: row.interval_days_before as number,
          },
    after: {
      stability: row.stability_after,
      difficulty: row.difficulty_after,
      reps: row.reps_after,
      intervalDays: row.interval_days_after,
    },
  };
}

export function reviewLogBindings(entry: ReviewLogEntry): Record<string, string | number | null> {
  return {
    moduleId: entry.moduleId,
    reviewedAt: entry.reviewedAt,
    grade: entry.grade,
    stabilityBefore: entry.before === null ? null : entry.before.stability,
    difficultyBefore: entry.before === null ? null : entry.before.difficulty,
    repsBefore: entry.before === null ? null : entry.before.reps,
    intervalDaysBefore: entry.before === null ? null : entry.before.intervalDays,
    stabilityAfter: entry.after.stability,
    difficultyAfter: entry.after.difficulty,
    repsAfter: entry.after.reps,
    intervalDaysAfter: entry.after.intervalDays,
  };
}

export function reviewUpsertBindings(item: ReviewItem): Record<string, string | number | null> {
  return {
    moduleId: item.moduleId,
    dueAt: item.dueAt,
    intervalDays: item.intervalDays,
    lapses: item.lapses,
    lastAssistLevel: item.lastAssistLevel,
    flaggedNeedsReview: item.flaggedNeedsReview ? 1 : 0,
    stability: item.memory.stability,
    difficulty: item.memory.difficulty,
    reps: item.memory.reps,
    lastReviewedAt: item.memory.lastReviewedAt,
  };
}

export function createReviewsRepo(db: Database.Database): ReviewsRepo {
  const dueStmt = db.prepare(
    'SELECT * FROM review_items WHERE due_at <= ? ORDER BY due_at ASC LIMIT ?',
  );
  const upsertStmt = db.prepare(REVIEW_UPSERT_SQL);
  const getStmt = db.prepare('SELECT * FROM review_items WHERE module_id = ?');
  const logInsertStmt = db.prepare(REVIEW_LOG_INSERT_SQL);
  const logForStmt = db.prepare('SELECT * FROM review_log WHERE module_id = ? ORDER BY id ASC');

  const upsertTx = db.transaction((item: ReviewItem, logEntry: ReviewLogEntry | undefined) => {
    upsertStmt.run(reviewUpsertBindings(item));
    if (logEntry !== undefined) {
      logInsertStmt.run(reviewLogBindings(logEntry));
    }
  });

  return {
    due(now: ISODateString, limit: number): ReviewItem[] {
      const rows = dueStmt.all(now, limit) as ReviewRow[];
      return rows.map(rowToReviewItem);
    },

    upsert(item: ReviewItem, logEntry?: ReviewLogEntry): void {
      const parsed = reviewItemSchema.safeParse(item);
      if (!parsed.success) {
        throw err('validation', { detail: 'review item failed shape validation' });
      }
      upsertTx(parsed.data, logEntry);
    },

    get(moduleId: string): ReviewItem | null {
      const row = getStmt.get(moduleId) as ReviewRow | undefined;
      if (!row) return null;
      return rowToReviewItem(row);
    },

    logFor(moduleId: string): ReviewLogEntry[] {
      const rows = logForStmt.all(moduleId) as ReviewLogRow[];
      return rows.map(rowToReviewLogEntry);
    },
  };
}
