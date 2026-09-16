// FRACTAL: covers F10 | type unit
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStore, closeStore, type Store } from '@/store/open';
import type { ModuleId } from '@/shapes';
import { nowIso, predictionPrompt, recordPrediction } from '@/reflect/prediction';

const PREDICTION_COUNT = 600;
const SAMPLES = 25;
const P95_BUDGET_MS = 100;

const moduleIds: ModuleId[] = [];

describe('prediction prompt render perf at scale', () => {
  let dataRoot: string;
  let store: Store;

  beforeAll(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-pred-perf-'));
    store = openStore(dataRoot);
    for (let i = 0; i < PREDICTION_COUNT; i += 1) {
      const id = `m_${String(i).padStart(16, '0')}` as ModuleId;
      moduleIds.push(id);
      recordPrediction(store, {
        moduleId: id,
        confidence: ((i % 5) + 1) as 1 | 2 | 3 | 4 | 5,
        expectation: `Expectation number ${i}`,
        skipped: i % 7 === 0,
        at: nowIso(),
      });
    }
  });

  afterAll(() => {
    closeStore(dataRoot);
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('seeds the declared scale of modules with predictions', () => {
    expect(moduleIds).toHaveLength(PREDICTION_COUNT);
    expect(store.predictions.get(moduleIds[PREDICTION_COUNT - 1])).not.toBeNull();
  });

  it('builds the prediction prompt under 100ms p95 over >=20 samples', () => {
    const samples: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const target = moduleIds[(i * 37) % PREDICTION_COUNT];
      const start = performance.now();
      const prompt = predictionPrompt(store, target);
      samples.push(performance.now() - start);
      expect(prompt.options).toHaveLength(5);
      expect(prompt.existing).not.toBeNull();
      expect(prompt.blocking).toBe(false);
    }
    expect(samples).toHaveLength(SAMPLES);
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(0.95 * samples.length) - 1];
    expect(p95).toBeLessThan(P95_BUDGET_MS);
  });
});
