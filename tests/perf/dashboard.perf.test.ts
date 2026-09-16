// FRACTAL: covers F5 | type unit
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoDateStringSchema, type ModuleGraph, type ModuleId, type ModuleNode } from '@/shapes';
import { paths } from '@/core/paths';
import { closeStore, openStore, type Store } from '@/store/open';
import { TOPIC_COMPARATOR, dashboard, dashboardViewSchema } from '@/graph/dashboard';
import { dashboardFor } from '@/api/dashboard-source';
import { progressCounts } from '@/graph/rollup';
import { completedSet } from '@/graph/availability';
import { lessonBlob } from './lesson-blob';

const TOPIC_COUNT = 50;
const MODULES_PER_TOPIC = 12;
const TOTAL_MODULES = TOPIC_COUNT * MODULES_PER_TOPIC;
const SAMPLES = 25;
const P95_BUDGET_MS = 300;

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

describe('dashboard perf at declared scale', () => {
  let dataRoot: string;
  let db: Database.Database;
  let store: Store;
  let blobBytes = 0;

  beforeAll(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-dash-perf-'));
    store = openStore(dataRoot);
    // WHY a real blob: every module row the dashboard reads is JSON.parse'd on the way out
    // (src/store/modules.ts:43). Seeding `content: null` skipped that cost entirely.
    const content = lessonBlob(0);
    blobBytes = Buffer.byteLength(JSON.stringify(content));

    for (let t = 0; t < TOPIC_COUNT; t += 1) {
      const topic = store.topics.create({
        subject: `Subject ${String(TOPIC_COUNT - t).padStart(3, '0')}`,
        level: 'intermediate',
        purpose: 'p',
        diagnostic: null,
      });
      const nodes: ModuleNode[] = [];
      for (let m = 0; m < MODULES_PER_TOPIC; m += 1) {
        const id = `m_${String(t).padStart(8, '0')}${String(m).padStart(8, '0')}` as ModuleId;
        const state: ModuleNode['state'] =
          m < 3 ? 'completed' : m === 3 ? 'assisted-pass' : m === 4 ? 'available' : m === 5 ? 'needs-review' : 'not-yet-recommended';
        nodes.push({
          id,
          topicId: topic.id,
          title: `Module ${m}`,
          ordinal: m,
          kind: m === MODULES_PER_TOPIC - 1 ? 'capstone' : 'module',
          testOutEligible: false,
          estimatedMinutes: 20,
          state,
          content,
        });
      }
      const graph: ModuleGraph = {
        topicId: topic.id,
        nodes,
        edges: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id })),
        entryModules: [nodes[0].id],
      };
      store.modules.upsertGraph(graph);
      store.reviews.upsert({
        moduleId: nodes[0].id,
        dueAt: isoDateStringSchema.parse('2026-01-01T00:00:00.000Z'),
        intervalDays: 3,
        memory: { stability: 3, difficulty: 2.1181, reps: 1, lastReviewedAt: null },
        lapses: 0,
        lastAssistLevel: 0,
        flaggedNeedsReview: false,
      });
    }

    db = new Database(paths(dataRoot).dbFile, { readonly: true });
  });

  afterAll(() => {
    db.close();
    closeStore(dataRoot);
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('seeds the declared scale: topics=50, modules=600, each carrying a real lesson blob', () => {
    expect(db.prepare('SELECT COUNT(*) AS n FROM topics').get()).toEqual({ n: TOPIC_COUNT });
    expect(db.prepare('SELECT COUNT(*) AS n FROM module_nodes').get()).toEqual({ n: TOTAL_MODULES });
    const { bytes } = db
      .prepare('SELECT SUM(LENGTH(content_json)) AS bytes FROM module_nodes')
      .get() as { bytes: number };
    // Real lessons in data/ run 20-30 KB of content_json; the seed has to be in that band or
    // the benchmark is measuring an empty database again.
    expect(blobBytes).toBeGreaterThan(20_000);
    expect(blobBytes).toBeLessThan(30_000);
    expect(bytes).toBe(blobBytes * TOTAL_MODULES);
    console.log(`[perf] seeded ${TOTAL_MODULES} modules x ${blobBytes} B content_json = ${(bytes / 1e6).toFixed(1)} MB`);
  });

  it('renders every topic with counts only, sorted by the hoisted comparator', () => {
    const view = dashboardFor(store);
    expect(dashboardViewSchema.safeParse(view).success).toBe(true);
    expect(view.topics).toHaveLength(TOPIC_COUNT);
    expect(view.reviewsDue).toBe(TOPIC_COUNT);
    expect(view.synthesisAvailable).toBe(true);
    const subjects = view.topics.map((t) => t.subject);
    expect(subjects).toEqual([...subjects].sort());
    // Counts as the SHIPPED path reports them (`storeDashboardSource` -> `progressCounts`),
    // which differ from the unused SQL source this test used to call: the capstone is excluded
    // from the totals, and `needs-review` is its own bucket rather than part of completed.
    // Per topic: 11 non-capstone modules, 3 completed + 1 assisted-pass, 1 available,
    // 1 needs-review, 5 not-yet-recommended.
    expect(view.topics[0].completedCount).toBe(4);
    expect(view.topics[0].needsReviewCount).toBe(1);
    expect(view.topics[0].availableCount).toBe(1);
  });

  it('sorts with a comparator hoisted out of the request path', () => {
    expect(typeof TOPIC_COMPARATOR).toBe('function');
    expect(TOPIC_COMPARATOR).toBe(TOPIC_COMPARATOR);
    const source = dashboard.toString();
    expect(source).toContain('TOPIC_COMPARATOR');
    expect(source).not.toMatch(/sort\(\s*\(/);
  });

  it('never reads content_json, and issues one query per topic rather than three passes', () => {
    const probe = new Database(':memory:');
    const proto = Object.getPrototypeOf(probe.prepare('SELECT 1'));
    probe.close();

    const originalAll = proto.all;
    const originalGet = proto.get;
    let calls = 0;
    const sql: string[] = [];
    proto.all = function patchedAll(...args: unknown[]) {
      calls += 1;
      sql.push(String((this as { source: string }).source));
      return originalAll.apply(this, args);
    };
    proto.get = function patchedGet(...args: unknown[]) {
      calls += 1;
      sql.push(String((this as { source: string }).source));
      return originalGet.apply(this, args);
    };
    try {
      calls = 0;
      const view = dashboardFor(store);
      expect(view.topics).toHaveLength(TOPIC_COUNT);
    } finally {
      proto.all = originalAll;
      proto.get = originalGet;
    }
    console.log(`[perf] dashboardFor issued ${calls} queries for ${TOPIC_COUNT} topics / ${TOTAL_MODULES} modules`);

    // The point of the fix: no statement the dashboard runs brings a lesson blob back, either
    // by naming content_json or by SELECT *ing the module_nodes row it lives in.
    const moduleReads = sql.filter((q) => q.includes('module_nodes'));
    expect(moduleReads.length).toBeGreaterThan(0);
    for (const q of moduleReads) {
      expect(q).not.toContain('content_json');
      expect(q).not.toMatch(/SELECT\s+\*/i);
    }
    // One graph traversal per topic, not two: nodes + edges + entry + the capstone session
    // lookup per topic, plus the topic list and the review query. Anything above this means
    // the second pass came back.
    expect(calls).toBeLessThanOrEqual(4 * TOPIC_COUNT + 2);
  });

  it('reports the same numbers for locked modules as a full-blob traversal does', () => {
    // The regression guard for the summary query and the merged pass: the dashboard computes
    // effective state via availability(), so a not-yet-recommended module must stay out of
    // completed/available. Recomputed here from the blob-carrying graph() for comparison.
    const view = dashboardFor(store);
    const expected = store.topics
      .list()
      .flatMap((topic) => ('degraded' in topic ? [] : [topic]))
      .map((topic) => {
        const graph = store.modules.graph(topic.id);
        expect(graph.nodes.every((n) => n.content !== null)).toBe(true);
        const counts = progressCounts(graph, completedSet(graph));
        return {
          subject: topic.subject,
          completedCount: counts.completedCount,
          availableCount: counts.availableCount,
          remainingCount: counts.remainingCount,
          needsReviewCount: counts.needsReviewCount,
          assistedPassCount: counts.assistedPassCount,
        };
      })
      .sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0));

    expect(
      view.topics.map((t) => ({
        subject: t.subject,
        completedCount: t.completedCount,
        availableCount: t.availableCount,
        remainingCount: t.remainingCount,
        needsReviewCount: t.needsReviewCount,
        assistedPassCount: t.assistedPassCount,
      })),
    ).toEqual(expected);
    // Of 11 non-capstone modules: 4 passed, module 4 available, and the other 6 — the
    // needs-review one plus five locked behind the prereq chain — remain.
    expect(view.topics[0].remainingCount).toBe(6);
  });

  it(`stays under the ${P95_BUDGET_MS}ms p95 budget over ${SAMPLES} samples`, () => {
    const samples: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const start = performance.now();
      const view = dashboardFor(store);
      expect(view.topics).toHaveLength(TOPIC_COUNT);
      samples.push(performance.now() - start);
    }
    expect(samples).toHaveLength(SAMPLES);
    const sorted = [...samples].sort((a, b) => a - b);
    console.log(
      `[perf] dashboardFor p50=${percentile(sorted, 0.5).toFixed(1)}ms p95=${percentile(sorted, 0.95).toFixed(1)}ms over ${SAMPLES} samples`,
    );
    expect(percentile(sorted, 0.5)).toBeLessThan(P95_BUDGET_MS);
    expect(percentile(sorted, 0.95)).toBeLessThan(P95_BUDGET_MS);
  });
});
