// FRACTAL: covers F5 | type recovery
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, closeStore } from '@/store/open';
import { paths } from '@/core/paths';

describe('degraded topic recovery', () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-degraded-'));
  });

  afterEach(() => {
    closeStore(dataRoot);
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('keeps other topics usable and lets the corrupt one be deleted without reading it', () => {
    const store = openStore(dataRoot);
    const good1 = store.topics.create({ subject: 'Linear algebra', level: 'beginner', purpose: 'p', diagnostic: null });
    const bad = store.topics.create({ subject: 'Measure theory', level: 'advanced', purpose: 'p', diagnostic: null });
    const good2 = store.topics.create({ subject: 'Combinatorics', level: 'intermediate', purpose: 'p', diagnostic: null });
    closeStore(dataRoot);

    const raw = new Database(paths(dataRoot).dbFile);
    raw.prepare('UPDATE topics SET diagnostic_json = ? WHERE id = ?').run('{"skipped": nope}', bad.id);
    raw.close();

    const reopened = openStore(dataRoot);
    const listed = reopened.topics.list();
    expect(listed).toHaveLength(3);

    const badEntry = listed.find((t) => t.id === bad.id) as { degraded: boolean };
    expect(badEntry.degraded).toBe(true);

    const good1Entry = listed.find((t) => t.id === good1.id) as { subject?: string; degraded?: boolean };
    const good2Entry = listed.find((t) => t.id === good2.id) as { subject?: string; degraded?: boolean };
    expect(good1Entry.degraded).toBeFalsy();
    expect(good1Entry.subject).toBe('Linear algebra');
    expect(good2Entry.degraded).toBeFalsy();
    expect(good2Entry.subject).toBe('Combinatorics');

    reopened.topics.delete(bad.id);
    const afterDelete = reopened.topics.list();
    expect(afterDelete).toHaveLength(2);
    expect(afterDelete.some((t) => t.id === bad.id)).toBe(false);
    expect(reopened.topics.get(good1.id)).not.toBeNull();
    expect(reopened.topics.get(good2.id)).not.toBeNull();
  });
});
