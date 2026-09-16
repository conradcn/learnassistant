// FRACTAL: covers F4 | type integration
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, closeStore } from '@/store/open';
import { paths } from '@/core/paths';
import { exampleEvalVerdict, type ModuleGraph, type ModuleId, type TopicId } from '@/shapes';
import { firstIntervalDays } from '@/review/schedule';

describe('completeModule', () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-complete-'));
  });

  afterEach(() => {
    closeStore(dataRoot);
    rmSync(dataRoot, { recursive: true, force: true });
  });

  function seedGraph(store: ReturnType<typeof openStore>) {
    const topic = store.topics.create({
      subject: 'Entropy',
      level: 'intermediate',
      purpose: 'build a compressor',
      diagnostic: null,
    });
    const m1 = 'm_0000000000000001' as ModuleId;
    const m2 = 'm_0000000000000002' as ModuleId;
    const m3 = 'm_0000000000000003' as ModuleId;
    const graph: ModuleGraph = {
      topicId: topic.id,
      nodes: [
        { id: m1, topicId: topic.id, title: 'A', ordinal: 1, kind: 'module', testOutEligible: false, estimatedMinutes: 20, state: 'available', content: null },
        { id: m2, topicId: topic.id, title: 'B', ordinal: 2, kind: 'module', testOutEligible: false, estimatedMinutes: 20, state: 'not-yet-recommended', content: null },
        { id: m3, topicId: topic.id, title: 'C', ordinal: 3, kind: 'module', testOutEligible: false, estimatedMinutes: 20, state: 'not-yet-recommended', content: null },
      ],
      edges: [
        { from: m1, to: m2 },
        { from: m1, to: m3 },
      ],
      entryModules: [m1],
    };
    store.modules.upsertGraph(graph);
    return { topicId: topic.id as TopicId, m1, m2, m3 };
  }

  it('completes a module, unlocks dependents, and schedules a review, all in one transaction', () => {
    const store = openStore(dataRoot);
    const { m1, m2, m3 } = seedGraph(store);

    const result = store.completeModule(m1, { ...exampleEvalVerdict, outcome: 'pass', assistLevel: 0 });

    expect(result.module.state).toBe('completed');
    expect(result.unlocked.sort()).toEqual([m2, m3].sort());
    expect(result.review.moduleId).toBe(m1);
    expect(result.review.intervalDays).toBeGreaterThan(0);

    const graph = store.modules.graph(store.topics.list()[0].id as TopicId);
    const node2 = graph.nodes.find((n) => n.id === m2);
    const node3 = graph.nodes.find((n) => n.id === m3);
    expect(node2?.state).toBe('available');
    expect(node3?.state).toBe('available');

    const review = store.reviews.get(m1);
    expect(review).not.toBeNull();
  });

  it('marks an assisted pass distinctly and schedules a shorter interval', () => {
    const store = openStore(dataRoot);
    const { m1 } = seedGraph(store);
    const result = store.completeModule(m1, { ...exampleEvalVerdict, outcome: 'assisted-pass', assistLevel: 2 });
    expect(result.module.state).toBe('assisted-pass');
    // Shorter than an unassisted pass, which is what F7 requires; C1 gets the number from
    // C7's memory model rather than carrying its own constant.
    expect(result.review.intervalDays).toBe(firstIntervalDays(2));
    expect(result.review.intervalDays).toBeLessThan(firstIntervalDays(0));
  });

  it('rejects completion for a failing verdict without changing any state', () => {
    const store = openStore(dataRoot);
    const { m1 } = seedGraph(store);
    expect(() => store.completeModule(m1, { ...exampleEvalVerdict, outcome: 'fail' })).toThrow();
    const graph = store.modules.graph(store.topics.list()[0].id as TopicId);
    expect(graph.nodes.find((n) => n.id === m1)?.state).toBe('available');
  });

  it('rolls back the entire transaction when a mid-way write fails', () => {
    const store = openStore(dataRoot);
    const { m1, m2, m3 } = seedGraph(store);

    const raw = new Database(paths(dataRoot).dbFile);
    raw.pragma('busy_timeout = 5000');
    raw.exec('DROP TABLE review_items');
    raw.close();

    expect(() => store.completeModule(m1, { ...exampleEvalVerdict, outcome: 'pass', assistLevel: 0 })).toThrow();

    const graph = store.modules.graph(store.topics.list()[0].id as TopicId);
    expect(graph.nodes.find((n) => n.id === m1)?.state).toBe('available');
    expect(graph.nodes.find((n) => n.id === m2)?.state).toBe('not-yet-recommended');
    expect(graph.nodes.find((n) => n.id === m3)?.state).toBe('not-yet-recommended');
  });
});
