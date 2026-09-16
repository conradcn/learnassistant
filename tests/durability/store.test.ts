// FRACTAL: covers F5 | type integration
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, closeStore, restoreFromPrevious, listPreviousGenerations } from '@/store/open';
import { paths } from '@/core/paths';
import { runMigrations, readRecordedVersion } from '@/store/migrations';
import type { MigrationStep } from '@/store/schema.sql';

describe('store durability', () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-durability-'));
  });

  afterEach(() => {
    closeStore(dataRoot);
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('falls back to .prev when the primary database is corrupt', () => {
    const store = openStore(dataRoot);
    store.topics.create({ subject: 'Chaos theory', level: 'advanced', purpose: 'p', diagnostic: null });
    closeStore(dataRoot);
    // reopening forces a fresh snapshotPrevious that captures the just-written data
    openStore(dataRoot);
    closeStore(dataRoot);

    const p = paths(dataRoot);
    expect(listPreviousGenerations(dataRoot).length).toBeGreaterThan(0);
    writeFileSync(p.dbFile, 'not a sqlite file at all, deliberately corrupted for test purposes');

    expect(() => openStore(dataRoot)).toThrow();

    restoreFromPrevious(dataRoot);
    const reopened = openStore(dataRoot);
    const listed = reopened.topics.list();
    expect(listed.some((t) => 'subject' in t && t.subject === 'Chaos theory')).toBe(true);
  });

  it('refuses to open a store whose recorded schema version is ahead of this build', () => {
    const p = paths(dataRoot);
    const db = new Database(p.dbFile);
    db.pragma('user_version = 999999');
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    db.close();

    expect(() => openStore(dataRoot)).toThrow();
  });

  it('leaves neither a partial schema nor a bumped version when a migration throws mid-run', () => {
    const p = paths(dataRoot);
    const db = new Database(p.dbFile);
    db.pragma('journal_mode = WAL');

    const badSteps: MigrationStep[] = [
      { version: 1, sql: 'CREATE TABLE ok_table (id TEXT PRIMARY KEY);' },
      { version: 2, sql: 'CREATE TABLE THIS IS NOT VALID SQL;;;' },
    ];

    expect(() => runMigrations(db, badSteps)).toThrow();
    expect(readRecordedVersion(db)).toBe(1);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ok_table'")
      .all();
    expect(tables).toHaveLength(1);

    db.close();
  });

  it.skipIf(process.platform === 'win32')('sets file mode 0600 on the database file', () => {
    openStore(dataRoot);
    const p = paths(dataRoot);
    const mode = statSync(p.dbFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('surfaces an unparseable topic row as a DegradedTopic rather than skipping it', () => {
    const store = openStore(dataRoot);
    const topic = store.topics.create({ subject: 'Graph theory', level: 'beginner', purpose: 'p', diagnostic: null });
    closeStore(dataRoot);

    const p = paths(dataRoot);
    const raw = new Database(p.dbFile);
    raw.prepare('UPDATE topics SET notes_json = ? WHERE id = ?').run('{not valid json', topic.id);
    raw.close();

    const reopened = openStore(dataRoot);
    const listed = reopened.topics.list();
    expect(listed).toHaveLength(1);
    expect((listed[0] as { degraded: boolean }).degraded).toBe(true);

    const fetched = reopened.topics.get(topic.id);
    expect(fetched && 'degraded' in fetched && fetched.degraded).toBe(true);
  });
});
