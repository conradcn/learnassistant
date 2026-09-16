// FRACTAL: covers F7 | type unit
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ISODateString, ModuleGraph, ModuleId, ModuleNode, ReviewItem } from '@/shapes';
import { locate } from '@/review/locate';
import { reviewQueue } from '@/review/queue';
import type { ModuleSummary } from '@/store/modules';
import { at, bootC7, type C7Harness } from '@/review/harness.testing';
import { lessonBlob } from './lesson-blob';

const TOPIC_COUNT = 20;
const MODULES_PER_TOPIC = 30;
const MODULES_UNDER_REVIEW = TOPIC_COUNT * MODULES_PER_TOPIC;
const QUEUE_DEPTH = 200;
const SAMPLES = 25;
// WHY 25ms: the budget was 300ms when the queue built its index out of `graph()` and so
// parsed all 15 MB of seeded content_json to read 600 titles. Blob-free, the same read
// measures ~1ms; the budget is set where a regression back to parsing blobs cannot hide.
const P95_BUDGET_MS = 25;

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

describe('F7 review queue at declared scale', () => {
  let h: C7Harness;
  let dueCalls: number;
  let graphCalls: number;
  let indexCalls: number;
  let countingStore: C7Harness['store'];

  let blobBytes = 0;

  beforeAll(() => {
    h = bootC7();
    // WHY a real blob: `store.modules.graph` JSON.parse's every module's content_json on
    // the way out, so seeding `content: null` meant no benchmark here had ever paid that.
    // The queue no longer reads a graph at all — this is what makes that visible.
    const content = lessonBlob(1);
    blobBytes = Buffer.byteLength(JSON.stringify(content));
    for (let t = 0; t < TOPIC_COUNT; t += 1) {
      const topic = h.store.topics.create({
        subject: `Subject ${String(t).padStart(3, '0')}`,
        level: 'intermediate',
        purpose: 'review at scale',
        diagnostic: null,
      });
      const nodes: ModuleNode[] = [];
      for (let m = 0; m < MODULES_PER_TOPIC; m += 1) {
        nodes.push({
          id: `m_${String(t).padStart(7, '0')}${String(m).padStart(9, '0')}` as ModuleId,
          topicId: topic.id,
          title: `Lesson ${t}-${m}`,
          ordinal: m + 1,
          kind: 'module',
          testOutEligible: false,
          estimatedMinutes: 20,
          state: 'completed',
          content,
        });
      }
      const graph: ModuleGraph = {
        topicId: topic.id,
        nodes,
        edges: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id })),
        entryModules: [nodes[0].id],
      };
      h.store.modules.upsertGraph(graph);
      nodes.forEach((node, i) => {
        const overdue = t * MODULES_PER_TOPIC + i < QUEUE_DEPTH;
        h.store.reviews.upsert({
          moduleId: node.id,
          dueAt: overdue ? at(-1) : at(365),
          intervalDays: overdue ? 1 : 180,
          memory: { stability: 3, difficulty: 2.1181, reps: 1, lastReviewedAt: null },
          lapses: 0,
          lastAssistLevel: 0,
          flaggedNeedsReview: false,
        });
      });
    }

    dueCalls = 0;
    graphCalls = 0;
    indexCalls = 0;
    countingStore = {
      ...h.store,
      reviews: {
        ...h.store.reviews,
        due: (now: ISODateString, limit: number): ReviewItem[] => {
          dueCalls += 1;
          return h.store.reviews.due(now, limit);
        },
      },
      modules: {
        ...h.store.modules,
        graph: (topicId): ModuleGraph => {
          graphCalls += 1;
          return h.store.modules.graph(topicId);
        },
        index: (): ModuleSummary[] => {
          indexCalls += 1;
          return h.store.modules.index();
        },
      },
    };
  });

  afterAll(() => {
    h.teardown();
  });

  it(`reads a ${QUEUE_DEPTH}-deep queue over ${MODULES_UNDER_REVIEW} modules in one due query, with no per-item query`, () => {
    dueCalls = 0;
    graphCalls = 0;
    indexCalls = 0;

    const queue = reviewQueue(countingStore, at(0), 50);

    expect(blobBytes).toBeGreaterThan(20_000);
    expect(blobBytes).toBeLessThan(30_000);
    console.log(
      `[perf] seeded ${MODULES_UNDER_REVIEW} modules x ${blobBytes} B content_json = ${((blobBytes * MODULES_UNDER_REVIEW) / 1e6).toFixed(1)} MB`,
    );
    expect(queue.dueTotal).toBe(QUEUE_DEPTH);
    expect(queue.shown).toBe(50);
    expect(dueCalls).toBe(1);
    // The queue names lessons; it never opens one. One blob-free sweep, no graph read.
    expect(indexCalls).toBe(1);
    expect(graphCalls).toBe(0);
  });

  it(`stays under ${P95_BUDGET_MS}ms p95`, () => {
    const samples: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const started = performance.now();
      reviewQueue(h.store, at(0));
      samples.push(performance.now() - started);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    expect(samples).toHaveLength(SAMPLES);
    console.log(
      `[perf] reviewQueue p50=${percentile(sorted, 0.5).toFixed(1)}ms p95=${percentile(sorted, 0.95).toFixed(1)}ms over ${SAMPLES} samples`,
    );
    expect(percentile(sorted, 0.95)).toBeLessThan(P95_BUDGET_MS);
  });

  it('does not grow its query count when the backlog grows', () => {
    dueCalls = 0;
    graphCalls = 0;
    indexCalls = 0;
    reviewQueue(countingStore, at(0));
    const shallow = { dueCalls, graphCalls, indexCalls };

    dueCalls = 0;
    graphCalls = 0;
    indexCalls = 0;
    reviewQueue(countingStore, at(400));
    expect({ dueCalls, graphCalls, indexCalls }).toEqual(shallow);
  });

  it('locates one module without parsing another lesson’s content', () => {
    const target = `m_${String(0).padStart(7, '0')}${String(7).padStart(9, '0')}` as ModuleId;
    const original = JSON.parse;
    const parsed: number[] = [];
    const spy = vi.spyOn(JSON, 'parse').mockImplementation(((text: string, reviver?: never) => {
      parsed.push(typeof text === 'string' ? text.length : 0);
      return original.call(JSON, text, reviver);
    }) as typeof JSON.parse);
    let located: ReturnType<typeof locate>;
    try {
      located = locate(h.store, target);
    } finally {
      spy.mockRestore();
    }

    expect(located?.node.id).toBe(target);
    expect(located?.node.content).not.toBeNull();
    const total = parsed.reduce((a, b) => a + b, 0);
    const blobs = parsed.filter((len) => len >= blobBytes);
    console.log(
      `[perf] locate() parsed ${blobs.length} blob(s), ${(total / 1e6).toFixed(2)} MB total, over ${MODULES_UNDER_REVIEW} seeded modules`,
    );
    // Exactly one content_json crosses JSON.parse: the lesson that was asked for.
    expect(blobs).toHaveLength(1);
    expect(total).toBeLessThan(blobBytes * 2);
  });
});
