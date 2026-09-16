// FRACTAL: covers F4 | type perf
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyOptimisticSend, EMPTY_CHAT, settleSend, type ChatView } from '@/eval/optimistic';
import { bootHarness, evaluatorOutput, seedTopic, type Harness } from '@/eval/harness.testing';

// Declared scale (F4): exchanges per evaluation = 20. The budget measures the
// UI overhead of the optimistic apply, never the backgrounded round trip.
const EXCHANGES = 20;
const P95_BUDGET_MS = 100;
const TS_DIR = path.resolve('e2e/perf/timeseries');
const RUN_ID = process.env.FRACTAL_RUN_ID ?? `${Date.now()}`;
const TS_FILE = path.join(TS_DIR, `f4.${RUN_ID}.ndjson`);

type Sample = { t: string; run: string; feature: string; op: string; durMs: number; ok: boolean; meta: Record<string, unknown> };

const samples: number[] = [];

function emit(sample: Sample): void {
  fs.mkdirSync(TS_DIR, { recursive: true });
  fs.appendFileSync(TS_FILE, `${JSON.stringify(sample)}\n`, 'utf8');
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))];
}

let h: Harness;

beforeEach(() => {
  h = bootHarness();
});

afterEach(async () => {
  await h.teardown();
});

afterAll(() => {
  if (samples.length === 0) return;
  const p95 = percentile(samples, 95);
  const p50 = percentile(samples, 50);
  const p99 = percentile(samples, 99);
  emit({
    t: new Date().toISOString(),
    run: RUN_ID,
    feature: 'F4',
    op: 'eval-send-summary',
    durMs: p95,
    ok: p95 < P95_BUDGET_MS,
    meta: { p50, p95, p99, n: samples.length, budgetMs: P95_BUDGET_MS },
  });
});

describe('F4 perf: optimistic send overhead across a full-length evaluation', () => {
  it(`keeps the optimistic apply under ${P95_BUDGET_MS}ms at p95 over ${EXCHANGES} exchanges`, async () => {
    const { nodes } = seedTopic(h.store);
    h.respondWith(() => evaluatorOutput({ reply: 'Keep going — what changes with a biased source?', angle: 'compression' }));
    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });

    let view: ChatView = EMPTY_CHAT;
    for (let i = 0; i < EXCHANGES; i += 1) {
      const message = { text: `Answer ${i + 1}: the expectation is taken over the source distribution.`, selfAssessment: null };
      const started = performance.now();
      const applied = applyOptimisticSend(view, message);
      const durMs = performance.now() - started;
      view = applied.view;

      expect(applied.view.composer.enabled).toBe(true);
      expect(applied.view.pending).toHaveLength(1);

      samples.push(durMs);
      emit({
        t: new Date().toISOString(),
        run: RUN_ID,
        feature: 'F4',
        op: 'eval-send-optimistic-apply',
        durMs,
        ok: true,
        meta: { exchange: i + 1, turns: view.turns.length },
      });

      const result = await h.engine.send(session.id, message);
      view = settleSend(view, applied.key, result);
    }

    expect(samples).toHaveLength(EXCHANGES);
    expect(view.turns.length).toBeGreaterThanOrEqual(EXCHANGES);
    const p95 = percentile(samples, 95);
    expect(p95, `PERF BREACH F4 eval-send-optimistic-apply: p95=${p95.toFixed(1)}ms (budget ${P95_BUDGET_MS}ms)`).toBeLessThan(
      P95_BUDGET_MS,
    );
  });
});
