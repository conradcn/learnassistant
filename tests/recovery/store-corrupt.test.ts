// FRACTAL: covers F5 | type recovery
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, closeStore, restoreFromPrevious, listPreviousGenerations } from '@/store/open';
import { paths } from '@/core/paths';

describe('corrupt store recovery: use the previous generation', () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-store-corrupt-'));
  });

  afterEach(() => {
    closeStore(dataRoot);
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('recovers via restoreFromPrevious after the primary database is corrupted', () => {
    const store = openStore(dataRoot);
    const topic = store.topics.create({ subject: 'Number theory', level: 'advanced', purpose: 'p', diagnostic: null });
    closeStore(dataRoot);
    // reopening forces a fresh snapshotPrevious that captures the just-written data
    openStore(dataRoot);
    closeStore(dataRoot);

    const p = paths(dataRoot);
    expect(listPreviousGenerations(dataRoot).length).toBeGreaterThan(0);
    writeFileSync(p.dbFile, Buffer.from([0, 1, 2, 3, 4, 5]));

    let threw = false;
    try {
      openStore(dataRoot);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    restoreFromPrevious(dataRoot);

    const recovered = openStore(dataRoot);
    const fetched = recovered.topics.get(topic.id);
    expect(fetched).toMatchObject({ id: topic.id, subject: 'Number theory' });

    const corruptFiles = readdirSync(p.dataRoot).filter((f: string) => f.startsWith('learn.db.corrupt-'));
    expect(corruptFiles.length).toBeGreaterThan(0);
  });

  it('throws when asked to restore and no previous generation exists', () => {
    expect(() => restoreFromPrevious(dataRoot)).toThrow();
  });
});
