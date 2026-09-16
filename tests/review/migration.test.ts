// FRACTAL: covers F7 | type integration
/**
 * A learner mid-course must not lose their schedule when F7 moves from the old
 * ease-based scheduler to FSRS-6. This drives a store forward from the pre-FSRS schema
 * with real rows in it and checks what comes out the other side.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reviewItemSchema } from '@/shapes';
import { MIGRATIONS } from '@/store/schema.sql';
import { runMigrations } from '@/store/migrations';
import { createReviewsRepo } from '@/store/reviews';
import { initialDifficultyForGood, LEGACY_MIN_EASE, LEGACY_START_EASE, memoryFromLegacy } from '@/review/memory';

const PRE_FSRS_VERSION = 4;

type LegacyRow = {
  moduleId: string;
  dueAt: string;
  intervalDays: number;
  ease: number;
  lapses: number;
  lastAssistLevel: number;
  flaggedNeedsReview: number;
};

const LEGACY_ROWS: LegacyRow[] = [
  // A fresh pass, never missed.
  { moduleId: 'm_00000000000000a1', dueAt: '2030-01-04T00:00:00.000Z', intervalDays: 3, ease: 2.5, lapses: 0, lastAssistLevel: 0, flaggedNeedsReview: 0 },
  // Months in, still clean.
  { moduleId: 'm_00000000000000a2', dueAt: '2030-06-01T00:00:00.000Z', intervalDays: 45, ease: 2.5, lapses: 0, lastAssistLevel: 0, flaggedNeedsReview: 0 },
  // Missed a few times: ease has been walked down.
  { moduleId: 'm_00000000000000a3', dueAt: '2030-02-01T00:00:00.000Z', intervalDays: 8, ease: 2.05, lapses: 3, lastAssistLevel: 2, flaggedNeedsReview: 1 },
  // Bottomed out at the old ease floor.
  { moduleId: 'm_00000000000000a4', dueAt: '2030-01-02T00:00:00.000Z', intervalDays: 1, ease: 1.3, lapses: 9, lastAssistLevel: 3, flaggedNeedsReview: 1 },
  // Parked at the old maximum interval.
  { moduleId: 'm_00000000000000a5', dueAt: '2030-07-01T00:00:00.000Z', intervalDays: 180, ease: 2.5, lapses: 0, lastAssistLevel: 1, flaggedNeedsReview: 0 },
];

let dir: string;
let db: Database.Database;

function openLegacyStore(): Database.Database {
  const file = path.join(dir, 'legacy.db');
  const handle = new Database(file);
  runMigrations(
    handle,
    MIGRATIONS.filter((m) => m.version <= PRE_FSRS_VERSION),
  );
  const insert = handle.prepare(`
    INSERT INTO review_items (module_id, due_at, interval_days, ease, lapses, last_assist_level, flagged_needs_review)
    VALUES (@moduleId, @dueAt, @intervalDays, @ease, @lapses, @lastAssistLevel, @flaggedNeedsReview)
  `);
  for (const row of LEGACY_ROWS) insert.run(row);
  return handle;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'la-c7-migration-'));
  db = openLegacyStore();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('F7 migration from the ease-based scheduler', () => {
  it('starts from a store that really is on the pre-FSRS schema', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(PRE_FSRS_VERSION);
    const columns = (db.pragma('table_info(review_items)') as { name: string }[]).map((c) => c.name);
    expect(columns).toContain('ease');
    expect(columns).not.toContain('stability');
  });

  it('keeps every row, its due instant, its interval and its lapse count', () => {
    runMigrations(db, MIGRATIONS);
    const reviews = createReviewsRepo(db);

    for (const legacy of LEGACY_ROWS) {
      const item = reviews.get(legacy.moduleId);
      expect(item, legacy.moduleId).not.toBeNull();
      expect(item?.dueAt).toBe(legacy.dueAt);
      expect(item?.intervalDays).toBe(legacy.intervalDays);
      expect(item?.lapses).toBe(legacy.lapses);
      expect(item?.lastAssistLevel).toBe(legacy.lastAssistLevel);
      expect(item?.flaggedNeedsReview).toBe(legacy.flaggedNeedsReview === 1);
      expect(reviewItemSchema.safeParse(item).success).toBe(true);
    }
  });

  it('drops `ease` and lands a valid FSRS memory state on every row', () => {
    runMigrations(db, MIGRATIONS);
    const columns = (db.pragma('table_info(review_items)') as { name: string }[]).map((c) => c.name);
    expect(columns).not.toContain('ease');

    const reviews = createReviewsRepo(db);
    for (const legacy of LEGACY_ROWS) {
      const memory = reviews.get(legacy.moduleId)?.memory;
      expect(memory?.stability, legacy.moduleId).toBeGreaterThan(0);
      expect(memory?.difficulty).toBeGreaterThanOrEqual(1);
      expect(memory?.difficulty).toBeLessThanOrEqual(10);
      expect(memory?.reps).toBe(1);
      // These rows never recorded when they were last answered; the reader derives it.
      expect(memory?.lastReviewedAt).toBeNull();
    }
  });

  it('derives the same memory state the code would, so the SQL cannot drift from it', () => {
    // The migration inlines FSRS's initial `good` difficulty as a literal, because a
    // migration is SQL and cannot call into the algorithm. This is the guard that the
    // literal still matches what ts-fsrs actually produces.
    runMigrations(db, MIGRATIONS);
    const reviews = createReviewsRepo(db);

    for (const legacy of LEGACY_ROWS) {
      const expected = memoryFromLegacy({ intervalDays: legacy.intervalDays, ease: legacy.ease });
      const actual = reviews.get(legacy.moduleId)?.memory;
      expect(actual?.stability, legacy.moduleId).toBeCloseTo(expected.stability, 4);
      expect(actual?.difficulty, legacy.moduleId).toBeCloseTo(expected.difficulty, 4);
    }
  });

  it('anchors the ease-to-difficulty map on values read off the algorithm, not guessed', () => {
    expect(memoryFromLegacy({ intervalDays: 10, ease: LEGACY_START_EASE }).difficulty).toBeCloseTo(
      initialDifficultyForGood(),
      4,
    );
    expect(memoryFromLegacy({ intervalDays: 10, ease: LEGACY_MIN_EASE }).difficulty).toBe(10);
  });

  it('leaves a migrated learner scheduled further out than a learner starting today', () => {
    // The point of the whole exercise: nobody mid-course gets reset to a 3-day interval.
    runMigrations(db, MIGRATIONS);
    const reviews = createReviewsRepo(db);
    const seasoned = reviews.get('m_00000000000000a2');
    expect(seasoned?.intervalDays).toBe(45);
    expect(seasoned?.memory.stability).toBeGreaterThan(
      memoryFromLegacy({ intervalDays: 3, ease: 2.5 }).stability,
    );
  });

  it('is idempotent: re-running the migration set changes nothing', () => {
    runMigrations(db, MIGRATIONS);
    const reviews = createReviewsRepo(db);
    const before = LEGACY_ROWS.map((r) => reviews.get(r.moduleId));

    runMigrations(db, MIGRATIONS);

    expect(LEGACY_ROWS.map((r) => reviews.get(r.moduleId))).toEqual(before);
  });
});
