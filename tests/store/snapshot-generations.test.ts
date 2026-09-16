// FRACTAL: covers F1, F5 | type integration
import { existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { paths } from '@/core/paths';
import { openStore, closeStore, listPreviousGenerations } from '@/store/open';
import { MIGRATIONS } from '@/store/schema.sql';
import { runMigrations } from '@/store/migrations';

/**
 * WHY (H3): a snapshot is only worth keeping as the data it holds. The pre-migration and
 * post-migration copies hold different data, so they must not share a filename — v5 reads
 * `review_items.ease` and then drops the column, and once the post-migration snapshot has
 * overwritten the pre-migration one those values exist in no file on disk.
 */
describe('snapshot generations survive the migration that produced them', () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-store-generations-'));
  });

  afterEach(() => {
    closeStore(dataRoot);
    rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function seedAtV4(): void {
    const p = paths(dataRoot);
    const db = new Database(p.dbFile);
    db.pragma('journal_mode = WAL');
    runMigrations(
      db,
      MIGRATIONS.filter((m) => m.version <= 4),
    );
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    db.prepare(
      `INSERT INTO review_items
         (module_id, due_at, interval_days, ease, lapses, last_assist_level, flagged_needs_review)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('m_seededreviewitem01', '2026-01-01T00:00:00.000Z', 9, 1.7, 3, 0, 0);
    db.close();
  }

  it('keeps the pre-v5 snapshot, with its pre-migration values, after the v5 migration ran', () => {
    seedAtV4();
    const p = paths(dataRoot);

    const store = openStore(dataRoot);
    expect(store.health().schemaVersion).toBeGreaterThanOrEqual(5);
    closeStore(dataRoot);

    const preV5 = p.dbPrevForVersion(4);
    expect(existsSync(preV5)).toBe(true);

    const snap = new Database(preV5, { readonly: true });
    const row = snap.prepare('SELECT ease, interval_days FROM review_items').get() as {
      ease: number;
      interval_days: number;
    };
    snap.close();
    expect(row.ease).toBeCloseTo(1.7, 6);
    expect(row.interval_days).toBe(9);
  });

  it('reports the generations it kept and which one Recover would restore', () => {
    seedAtV4();
    const store = openStore(dataRoot);
    const health = store.health();

    const versions = health.prevGenerations.map((g) => g.schemaVersion);
    expect(versions).toContain(4);
    expect(versions).toContain(health.schemaVersion);
    // Recover puts back the newest good copy, not the oldest one lying around.
    expect(health.restorableGeneration?.schemaVersion).toBe(health.schemaVersion);
    expect(listPreviousGenerations(dataRoot)[0]?.fileName).toBe(
      path.basename(paths(dataRoot).dbPrevForVersion(health.schemaVersion)),
    );
  });

  it('aborts the open rather than migrating when the pre-migration snapshot cannot be written', () => {
    seedAtV4();
    // A directory sitting on the path the snapshot writes through stands in for the full
    // disk: the write cannot land, whatever the reason.
    mkdirSync(`${paths(dataRoot).dbPrevForVersion(4)}.tmp`);

    expect(() => openStore(dataRoot)).toThrow();

    const db = new Database(paths(dataRoot).dbFile, { readonly: true });
    const version = db.pragma('user_version', { simple: true }) as number;
    const hasEase = (db.prepare('PRAGMA table_info(review_items)').all() as { name: string }[]).some(
      (c) => c.name === 'ease',
    );
    db.close();
    expect(version).toBe(4);
    expect(hasEase).toBe(true);
  });
});
