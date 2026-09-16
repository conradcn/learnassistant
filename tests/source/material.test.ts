// FRACTAL: covers F2 | type unit
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SourceId, TopicId } from '@/shapes';
import { paths } from '@/core/paths';
import { closeStore, openStore, type Store } from '@/store/open';
import { newSourceId } from '@/store/source';
import { writeSourceDocument } from '@/source/store';
import { loadMaterial, moduleView, researchView, resetMaterialCache } from '@/source/material';

const SYLLABUS = [
  'Unit 1: Probability review',
  'Random variables, expectation and the law of large numbers.',
  '',
  'Unit 2: Entropy',
  'Shannon entropy of a discrete source, joint and conditional entropy.',
].join('\n');

const SECOND_VOLUME = [
  'Unit 2: Entropy',
  'The same unit, named again by the second volume.',
  '',
  'Unit 3: Source coding',
  'Huffman codes and the source coding theorem for a memoryless source.',
].join('\n');

describe('a topic’s material, as F2 reads it', () => {
  let dataRoot: string;
  let store: Store;
  let topicId: TopicId;

  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-material-'));
    resetMaterialCache();
    store = openStore(dataRoot);
    topicId = store.topics.create({
      subject: 'Information theory',
      level: 'intermediate',
      purpose: 'build a compressor',
      diagnostic: null,
    }).id;
  });

  afterEach(() => {
    closeStore(dataRoot);
    resetMaterialCache();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  /** One document, on disk and in the index, exactly as `attachSources` leaves it. */
  function attach(filename: string, text: string, units: { label: string; title: string }[]): SourceId {
    const id = newSourceId();
    const record = {
      id,
      filename,
      kind: 'text' as const,
      byteSize: Buffer.byteLength(text, 'utf8'),
      charCount: text.length,
      pageCount: null,
      truncated: false,
      units,
    };
    writeSourceDocument(dataRoot, topicId, record, text, null);
    store.sources.add({ ...record, topicId });
    resetMaterialCache();
    return id;
  }

  it('is null for a topic that brought nothing, which is the path an empty intake takes', () => {
    expect(loadMaterial(store, dataRoot, topicId)).toBeNull();
  });

  it('merges documents in the order they were added and de-duplicates repeated units', () => {
    attach('volume-one.txt', SYLLABUS, [
      { label: 'Unit 1', title: 'Probability review' },
      { label: 'Unit 2', title: 'Entropy' },
    ]);
    attach('volume-two.txt', SECOND_VOLUME, [
      { label: 'Unit 2', title: 'Entropy' },
      { label: 'Unit 3', title: 'Source coding' },
    ]);

    const material = loadMaterial(store, dataRoot, topicId);

    expect(material?.documentCount).toBe(2);
    expect(material?.units.map((u) => u.title)).toEqual([
      'Probability review',
      'Entropy',
      'Source coding',
    ]);
    // Both volumes are chunked, and the ordinals are renumbered across the whole corpus
    // so an excerpt can be put back into reading order.
    expect(material?.chunks.length).toBeGreaterThanOrEqual(2);
    expect(material?.chunks.map((c) => c.ordinal)).toEqual(material?.chunks.map((_, i) => i));
    expect(material?.chunks[0].label).toContain('volume-one.txt');
    expect(material?.chunks.at(-1)?.label).toContain('volume-two.txt');
  });

  it('reads units out of the text when the index recorded none for a document', () => {
    const id = newSourceId();
    const record = {
      id,
      filename: 'syllabus.txt',
      kind: 'text' as const,
      byteSize: Buffer.byteLength(SYLLABUS, 'utf8'),
      charCount: SYLLABUS.length,
      pageCount: null,
      truncated: false,
      units: [],
    };
    writeSourceDocument(dataRoot, topicId, record, SYLLABUS, null);
    store.sources.add({ ...record, topicId });

    expect(loadMaterial(store, dataRoot, topicId)?.units.map((u) => u.title)).toEqual([
      'Probability review',
      'Entropy',
    ]);
  });

  it('drops a document the disk no longer has rather than failing the whole topic', () => {
    attach('volume-one.txt', SYLLABUS, [{ label: 'Unit 1', title: 'Probability review' }]);
    const gone = attach('volume-two.txt', SECOND_VOLUME, [{ label: 'Unit 3', title: 'Source coding' }]);
    unlinkSync(path.join(paths(dataRoot).sourceDir(topicId), `${gone}.txt`));

    const material = loadMaterial(store, dataRoot, topicId);

    expect(material?.documentCount).toBe(1);
    expect(material?.units.map((u) => u.title)).toEqual(['Probability review']);
  });

  it('is null when the index has rows but not one of them is readable', () => {
    const gone = attach('volume-one.txt', SYLLABUS, [{ label: 'Unit 1', title: 'Probability review' }]);
    unlinkSync(path.join(paths(dataRoot).sourceDir(topicId), `${gone}.txt`));

    expect(loadMaterial(store, dataRoot, topicId)).toBeNull();
  });

  it('carries a truncated document’s flag through to every view', () => {
    const id = newSourceId();
    const record = {
      id,
      filename: 'textbook.txt',
      kind: 'text' as const,
      byteSize: 4_000_000,
      charCount: SYLLABUS.length,
      pageCount: null,
      truncated: true,
      units: [{ label: 'Unit 1', title: 'Probability review' }],
    };
    writeSourceDocument(dataRoot, topicId, record, SYLLABUS, null);
    store.sources.add({ ...record, topicId });

    const material = loadMaterial(store, dataRoot, topicId);

    expect(material?.truncated).toBe(true);
    expect(researchView(material!).truncated).toBe(true);
    expect(moduleView(material!, 'Entropy').truncated).toBe(true);
  });

  describe('the memo', () => {
    it('answers a second read without going back to disk', () => {
      const id = attach('volume-one.txt', SYLLABUS, [{ label: 'Unit 1', title: 'Probability review' }]);
      const first = loadMaterial(store, dataRoot, topicId);
      unlinkSync(path.join(paths(dataRoot).sourceDir(topicId), `${id}.txt`));

      // The material of a topic does not change after intake, so ten authoring sessions
      // asking for an excerpt cost one parse, not ten.
      expect(loadMaterial(store, dataRoot, topicId)).toBe(first);
    });

    it('is keyed per topic, so one topic’s material never answers for another’s', () => {
      attach('volume-one.txt', SYLLABUS, [{ label: 'Unit 1', title: 'Probability review' }]);
      const other = store.topics.create({
        subject: 'Topology',
        level: 'beginner',
        purpose: 'read a proof',
        diagnostic: null,
      }).id;

      expect(loadMaterial(store, dataRoot, topicId)?.documentCount).toBe(1);
      expect(loadMaterial(store, dataRoot, other)).toBeNull();
    });

    it('caches the empty answer too, and resetMaterialCache clears it', () => {
      expect(loadMaterial(store, dataRoot, topicId)).toBeNull();
      const id = newSourceId();
      const record = {
        id,
        filename: 'late.txt',
        kind: 'text' as const,
        byteSize: Buffer.byteLength(SYLLABUS, 'utf8'),
        charCount: SYLLABUS.length,
        pageCount: null,
        truncated: false,
        units: [{ label: 'Unit 1', title: 'Probability review' }],
      };
      writeSourceDocument(dataRoot, topicId, record, SYLLABUS, null);
      store.sources.add({ ...record, topicId });

      expect(loadMaterial(store, dataRoot, topicId)).toBeNull();
      resetMaterialCache();
      expect(loadMaterial(store, dataRoot, topicId)?.documentCount).toBe(1);
    });
  });

  describe('the views handed to a session', () => {
    beforeEach(() => {
      attach('volume-one.txt', SYLLABUS, [
        { label: 'Unit 1', title: 'Probability review' },
        { label: 'Unit 2', title: 'Entropy' },
      ]);
      attach('volume-two.txt', SECOND_VOLUME, [{ label: 'Unit 3', title: 'Source coding' }]);
    });

    it('gives research the whole of the scope and the material’s own vocabulary', () => {
      const brief = researchView(loadMaterial(store, dataRoot, topicId)!);

      expect(brief.documentCount).toBe(2);
      expect(brief.units.map((u) => u.title)).toEqual(['Probability review', 'Entropy', 'Source coding']);
      expect(brief.blocks.length).toBeGreaterThan(0);
      expect(brief.keyTerms.length).toBeGreaterThan(0);
      expect(brief.omitted).toBe(0);
    });

    it('gives one authoring session the passages about its own idea', () => {
      const brief = moduleView(loadMaterial(store, dataRoot, topicId)!, 'Source coding: Huffman codes');

      expect(brief.blocks.map((b) => b.text).join('\n')).toContain('Huffman');
      // The scope travels with the excerpt: a lesson still writes in the material's words.
      expect(brief.units.map((u) => u.title)).toContain('Source coding');
    });
  });
});
