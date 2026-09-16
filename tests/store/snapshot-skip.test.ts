// FRACTAL: covers F1, F5 | type integration
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { paths } from '@/core/paths';
import { openStore, closeStore } from '@/store/open';
import { MIGRATIONS } from '@/store/schema.sql';
import { runMigrations } from '@/store/migrations';

/**
 * WHY (H3): `VACUUM INTO` reads and writes the whole database. Doing it twice per process
 * start buys nothing when no migration ran — the second copy is byte for byte the first —
 * and the cost lands on the first request that builds the lazy services().
 */
describe('the post-migration snapshot is skipped when nothing migrated', () => {
  let dataRoot: string;
  let vacuums: string[];
  const realPrepare = Database.prototype.prepare;

  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-store-snapshot-skip-'));
    vacuums = [];
    // The only place a VACUUM INTO is issued is snapshotPrevious, so counting the prepared
    // statement counts the snapshots without reaching into the module's internals.
    Database.prototype.prepare = function (this: Database.Database, sql: string) {
      if (/VACUUM\s+INTO/i.test(sql)) vacuums.push(sql);
      return realPrepare.call(this, sql);
    } as typeof Database.prototype.prepare;
  });

  afterEach(() => {
    Database.prototype.prepare = realPrepare;
    closeStore(dataRoot);
    rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('takes no snapshot at all when it is creating the database file', () => {
    openStore(dataRoot);
    expect(vacuums).toHaveLength(0);
  });

  it('takes exactly one snapshot when opening an already-current database', () => {
    openStore(dataRoot);
    closeStore(dataRoot);
    vacuums = [];

    const store = openStore(dataRoot);
    expect(vacuums).toHaveLength(1);
    expect(store.health().schemaVersion).toBe(store.health().highestKnownMigration);
  });

  it('still leaves both the pre-migration snapshot and the current file intact when a migration runs', () => {
    const p = paths(dataRoot);
    const seed = new Database(p.dbFile);
    seed.pragma('journal_mode = WAL');
    runMigrations(
      seed,
      MIGRATIONS.filter((m) => m.version <= 4),
    );
    seed.close();
    vacuums = [];

    const store = openStore(dataRoot);
    const current = store.health().schemaVersion;

    expect(vacuums).toHaveLength(2);
    expect(current).toBeGreaterThan(4);
    expect(existsSync(p.dbPrevForVersion(4))).toBe(true);
    expect(existsSync(p.dbPrevForVersion(current))).toBe(true);
    expect(existsSync(p.dbFile)).toBe(true);
  });
});
