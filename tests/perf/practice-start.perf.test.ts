// FRACTAL: covers F8 | type unit
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  exampleEvalScript,
  exampleModuleContent,
  type ModuleGraph,
  type ModuleId,
  type ModuleNode,
} from '@/shapes';
import { MAX_PRACTICE_SIZE, startPractice } from '@/practice/session';
import { at, bootC7, type C7Harness } from '@/review/harness.testing';

const TOPIC_COUNT = 20;
const MODULES_PER_TOPIC = 30;
const CANDIDATE_POOL = TOPIC_COUNT * MODULES_PER_TOPIC;
const SAMPLES = 25;
const P95_BUDGET_MS = 300;

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

describe('F8 practice start at declared scale', () => {
  let h: C7Harness;

  beforeAll(() => {
    h = bootC7();
    for (let t = 0; t < TOPIC_COUNT; t += 1) {
      const topic = h.store.topics.create({
        subject: `Subject ${String(t).padStart(3, '0')}`,
        level: 'intermediate',
        purpose: 'practice at scale',
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
          content: { ...exampleModuleContent, evalScript: exampleEvalScript },
        });
      }
      const graph: ModuleGraph = {
        topicId: topic.id,
        nodes,
        edges: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id })),
        entryModules: [nodes[0].id],
      };
      h.store.modules.upsertGraph(graph);
      for (const node of nodes) {
        h.store.reviews.upsert({
          moduleId: node.id,
          dueAt: at(-1),
          intervalDays: 3,
          memory: { stability: 3, difficulty: 2.1181, reps: 1, lastReviewedAt: null },
          lapses: 0,
          lastAssistLevel: 0,
          flaggedNeedsReview: false,
        });
      }
    }
  });

  afterAll(() => {
    h.teardown();
  });

  it(`starts a session in under ${P95_BUDGET_MS}ms p95 with a pool of ${CANDIDATE_POOL} modules`, () => {
    const samples: number[] = [];
    let lastSize = 0;
    for (let i = 0; i < SAMPLES; i += 1) {
      const started = performance.now();
      const { session } = startPractice({ store: h.store, practice: h.practice }, MAX_PRACTICE_SIZE, at(30));
      samples.push(performance.now() - started);
      lastSize = session.questions.length;
    }

    expect(lastSize).toBe(MAX_PRACTICE_SIZE);
    const sorted = [...samples].sort((a, b) => a - b);
    expect(samples).toHaveLength(SAMPLES);
    expect(percentile(sorted, 0.95)).toBeLessThan(P95_BUDGET_MS);
  });

  it('spreads a session over many subjects rather than draining one', () => {
    const { session, plan } = startPractice(
      { store: h.store, practice: h.practice },
      MAX_PRACTICE_SIZE,
      at(30),
    );
    const perTopicMax = Math.max(...plan.perTopic.map((r) => r.count));
    expect(perTopicMax).toBeLessThanOrEqual(Math.ceil(MAX_PRACTICE_SIZE / 2));
    expect(new Set(session.questions.map((q) => q.topicId)).size).toBeGreaterThan(1);
  });
});
