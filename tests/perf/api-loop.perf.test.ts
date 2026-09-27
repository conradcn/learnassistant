// FRACTAL: covers F1 | type unit
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  exampleModuleContent,
  isoDateStringSchema,
  moduleIdSchema,
  type ISODateString,
  type ModuleGraph,
  type ModuleId,
  type ModuleNode,
  type TopicId,
} from '@/shapes';
import { loadConfig, resetConfigCache } from '@/core/config';
import { openStore } from '@/store/open';
import { resetServices } from '@/api/services';
import { resetTokenCache, sessionToken } from '@/api/token';
import { GET as getTopics } from '../../app/api/topics/route';
import { GET as getTopic } from '../../app/api/topics/[id]/route';
import { GET as getModule } from '../../app/api/modules/[id]/route';
import { GET as getReviewsDue } from '../../app/api/reviews/due/route';

const TOPIC_COUNT = 50;
const MODULES_PER_TOPIC = 12;
const SAMPLES = 20;
const HEARTBEAT_MS = 5;
const HEARTBEAT_P95_BUDGET_MS = 100;
// WHY (H8): an absolute heartbeat budget measures the machine, not the route — under a
// loaded test runner it fails for reasons the code cannot cause, and a check that fails
// at random teaches everyone to ignore it. The route's heartbeat is therefore compared
// against an idle baseline measured in the same process, which still fails loudly for a
// route that actually blocks the loop (see the deliberately-blocking probe below).
const HEARTBEAT_OVER_IDLE_FACTOR = 4;
const ROUTE_P95_BUDGET_MS = 300;

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function req(urlPath: string): Request {
  const port = loadConfig().port;
  return new Request(`http://127.0.0.1:${port}${urlPath}`, {
    method: 'GET',
    headers: {
      host: `127.0.0.1:${port}`,
      'x-la-token': sessionToken(),
      origin: `http://127.0.0.1:${port}`,
    },
  });
}

type Probe = {
  label: string;
  run: () => Promise<Response>;
};

async function idleGaps(): Promise<number[]> {
  const gaps: number[] = [];
  let last = performance.now();
  const heartbeat = setInterval(() => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
  }, HEARTBEAT_MS);
  try {
    for (let i = 0; i < SAMPLES; i += 1) await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS));
  } finally {
    clearInterval(heartbeat);
  }
  return gaps;
}

async function measure(probe: Probe): Promise<{ durations: number[]; gaps: number[] }> {
  const gaps: number[] = [];
  const durations: number[] = [];
  let last = performance.now();
  const heartbeat = setInterval(() => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
  }, HEARTBEAT_MS);
  try {
    for (let i = 0; i < SAMPLES; i += 1) {
      const start = performance.now();
      const res = await probe.run();
      durations.push(performance.now() - start);
      expect(res.status, probe.label).toBe(200);
      await res.arrayBuffer();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // WHY: a fast runner can finish every sample in fewer ticks than it takes to judge the
    // heartbeat. Waiting out the rest is not blocking, so it cannot hide a route that is.
    while (gaps.length <= SAMPLES / 2) await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS));
  } finally {
    clearInterval(heartbeat);
  }
  return { durations, gaps };
}

describe('no route blocks the event loop at declared scale', () => {
  let dataRoot: string;
  let firstTopic: TopicId;
  let firstModule: ModuleId;
  const now: ISODateString = isoDateStringSchema.parse('2030-01-01T00:00:00.000Z');

  beforeAll(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-api-perf-'));
    process.env.LA_DATA_ROOT = dataRoot;
    resetConfigCache();
    resetTokenCache();
    resetServices();
    const store = openStore(dataRoot);

    for (let t = 0; t < TOPIC_COUNT; t += 1) {
      const topic = store.topics.create({
        subject: `Subject ${String(t).padStart(3, '0')}`,
        level: 'intermediate',
        purpose: 'perf',
        diagnostic: null,
      });
      const nodes: ModuleNode[] = [];
      for (let m = 0; m < MODULES_PER_TOPIC; m += 1) {
        const id = moduleIdSchema.parse(`m_${String(t).padStart(8, '0')}${String(m).padStart(8, '0')}`);
        nodes.push({
          id,
          topicId: topic.id,
          title: `Module ${m}`,
          ordinal: m,
          kind: m === MODULES_PER_TOPIC - 1 ? 'capstone' : 'module',
          testOutEligible: false,
          estimatedMinutes: 20,
          state: m < 4 ? 'completed' : m === 4 ? 'available' : 'not-yet-recommended',
          // WHY these subjects are already written: this measures what a READ route costs at
          // declared scale. Left unwritten, fifty subjects of available-but-empty lessons meant
          // the prep sweep fired on the very boot this test triggers and the app spent the
          // measurement authoring them — with the real `claude` binary, forty-odd child
          // processes deep. What the heartbeat then recorded was the host spawning sessions,
          // not a route holding the loop, and it moved with `sessionConcurrency` for that
          // reason alone. The writer has its own tests; this one reads.
          content: exampleModuleContent,
        });
      }
      const graph: ModuleGraph = {
        topicId: topic.id,
        nodes,
        edges: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id })),
        entryModules: [nodes[0].id],
      };
      store.modules.upsertGraph(graph);
      if (t === 0) {
        firstTopic = topic.id;
        firstModule = nodes[5].id;
      }
      store.reviews.upsert({
        moduleId: nodes[0].id,
        dueAt: now,
        intervalDays: 1,
        memory: { stability: 3, difficulty: 2.1181, reps: 1, lastReviewedAt: null },
        lapses: 0,
        lastAssistLevel: 0,
        flaggedNeedsReview: false,
      });
    }
  });

  afterAll(() => {
    resetServices();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  const probes = (): Probe[] => [
    { label: 'GET /api/topics', run: () => getTopics(req('/api/topics'), { params: Promise.resolve({}) }) },
    {
      label: 'GET /api/topics/:id',
      run: () => getTopic(req(`/api/topics/${firstTopic}`), { params: Promise.resolve({ id: firstTopic }) }),
    },
    {
      label: 'GET /api/modules/:id',
      run: () => getModule(req(`/api/modules/${firstModule}`), { params: Promise.resolve({ id: firstModule }) }),
    },
    {
      label: 'GET /api/reviews/due',
      run: () => getReviewsDue(req('/api/reviews/due'), { params: Promise.resolve({}) }),
    },
  ];

  it('keeps a 5ms heartbeat ticking while every read route runs', async () => {
    const idle = percentile(await idleGaps(), 0.95);
    const ceiling = Math.max(HEARTBEAT_P95_BUDGET_MS, idle * HEARTBEAT_OVER_IDLE_FACTOR);
    for (const probe of probes()) {
      const { durations, gaps } = await measure(probe);
      expect(durations.length, probe.label).toBe(SAMPLES);
      expect(gaps.length, probe.label).toBeGreaterThan(SAMPLES / 2);
      expect(
        percentile(gaps, 0.95),
        `${probe.label} heartbeat p95 (idle baseline ${idle.toFixed(1)}ms)`,
      ).toBeLessThan(ceiling);
      expect(percentile(durations, 0.95), `${probe.label} route p95`).toBeLessThan(ROUTE_P95_BUDGET_MS);
    }
  });

  // WHY (H8): a check that cannot fail is worse than no check — this proves the
  // heartbeat probe does detect a handler that holds the loop.
  it('fails against a deliberately blocking handler', async () => {
    const idle = percentile(await idleGaps(), 0.95);
    const ceiling = Math.max(HEARTBEAT_P95_BUDGET_MS, idle * HEARTBEAT_OVER_IDLE_FACTOR);
    const { gaps } = await measure({
      label: 'blocking probe',
      run: async () => {
        const until = performance.now() + 250;
        while (performance.now() < until) {
          /* deliberately hold the event loop */
        }
        return new Response('{}', { status: 200 });
      },
    });
    expect(percentile(gaps, 0.95)).toBeGreaterThan(ceiling);
  });
});
