// FRACTAL: covers F7 | type integration
/**
 * `review_items` holds one row per module forever, and every grade overwrites it. That is
 * fine for "when is this next due" and useless for "why does this lesson keep reappearing".
 * These tests pin the append-only `review_log` that keeps the sequence: the current-state
 * table must still collapse to one row while the log grows one row per graded retrieval,
 * in order, each carrying its grade and the state on both sides of it.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ISODateString, ModuleId } from '@/shapes';
import { MIGRATIONS, HIGHEST_KNOWN_MIGRATION } from '@/store/schema.sql';
import { runMigrations } from '@/store/migrations';
import {
  createReviewsRepo,
  reviewUpsertBindings,
  snapshotOf,
  REVIEW_UPSERT_SQL,
  type ReviewLogEntry,
} from '@/store/reviews';
import { scheduledOnCompletion, advanced, type ReviewGrade } from '@/review/schedule';

const REVIEW_LOG_VERSION = 7;
const MODULE = 'm_00000000000000b1' as ModuleId;

describe('review_log', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'la-review-log-'));
    db = new Database(path.join(dir, 'store.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps one review_items row and one log entry per graded retrieval', () => {
    runMigrations(db, MIGRATIONS);
    const reviews = createReviewsRepo(db);

    // The first schedule: a completion, no prior state.
    const t0 = '2030-01-01T00:00:00.000Z' as ISODateString;
    const first = scheduledOnCompletion(MODULE, 0, t0);
    reviews.upsert(first, {
      moduleId: MODULE,
      reviewedAt: t0,
      grade: 'good',
      before: null,
      after: snapshotOf(first),
    });

    // Then two graded retrievals over the same module.
    const later: { at: ISODateString; grade: ReviewGrade }[] = [
      { at: '2030-01-04T00:00:00.000Z' as ISODateString, grade: 'again' },
      { at: '2030-01-05T00:00:00.000Z' as ISODateString, grade: 'good' },
    ];
    const expected: ReviewLogEntry[] = [
      { moduleId: MODULE, reviewedAt: t0, grade: 'good', before: null, after: snapshotOf(first) },
    ];
    for (const { at, grade } of later) {
      const existing = reviews.get(MODULE);
      expect(existing).not.toBeNull();
      const next = advanced(existing!, grade, at);
      reviews.upsert(next, {
        moduleId: MODULE,
        reviewedAt: at,
        grade,
        before: snapshotOf(existing!),
        after: snapshotOf(next),
      });
      expected.push({ moduleId: MODULE, reviewedAt: at, grade, before: snapshotOf(existing!), after: snapshotOf(next) });
    }

    const itemCount = db.prepare('SELECT count(*) AS n FROM review_items WHERE module_id = ?').get(MODULE) as {
      n: number;
    };
    expect(itemCount.n).toBe(1);

    const entries = reviews.logFor(MODULE);
    expect(entries).toHaveLength(3);
    expect(entries).toEqual(expected);

    // Each entry's `after` is the next entry's `before`: the chain is continuous, and the
    // last `after` is what the surviving `review_items` row actually holds.
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i].before).toEqual(entries[i - 1].after);
    }
    expect(entries[2].after).toEqual(snapshotOf(reviews.get(MODULE)!));
  });

  it('adds review_log to a store already at the previous schema version', () => {
    const before = MIGRATIONS.filter((m) => m.version < REVIEW_LOG_VERSION);
    runMigrations(db, before);
    expect(db.pragma('user_version', { simple: true })).toBe(REVIEW_LOG_VERSION - 1);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'review_log'").get()).toEqual({ n: 0 });

    // A store with a real row in it, so the migration is not run against an empty table.
    // Written through the raw statement rather than the repo, because the repo prepares a
    // `review_log` query up front and cannot be built until the table exists.
    const item = scheduledOnCompletion(MODULE, 0, '2030-01-01T00:00:00.000Z' as ISODateString);
    db.prepare(REVIEW_UPSERT_SQL).run(reviewUpsertBindings(item));

    runMigrations(db, MIGRATIONS);
    expect(db.pragma('user_version', { simple: true })).toBe(HIGHEST_KNOWN_MIGRATION);
    expect(createReviewsRepo(db).get(MODULE)).toEqual(item);

    // The new table is usable, and empty — the migration invents no history.
    expect(createReviewsRepo(db).logFor(MODULE)).toEqual([]);
  });
});
