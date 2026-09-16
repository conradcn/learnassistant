// FRACTAL: covers F5 | type unit
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStore, closeStore } from '@/store/open';
import type { ModuleGraph, ModuleId, ModuleNode } from '@/shapes';

const TOPIC_COUNT = 50;
const MODULES_PER_TOPIC = 12;

describe('store scale + dashboard read perf', () => {
  let dataRoot: string;
  let store: ReturnType<typeof openStore>;

  beforeAll(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-perf-'));
    store = openStore(dataRoot);

    for (let t = 0; t < TOPIC_COUNT; t += 1) {
      const topic = store.topics.create({
        subject: `Subject ${t}`,
        level: 'intermediate',
        purpose: 'p',
        diagnostic: null,
      });
      const nodes: ModuleNode[] = [];
      for (let m = 0; m < MODULES_PER_TOPIC; m += 1) {
        const id = `m_${String(t).padStart(3, '0')}${String(m).padStart(13, '0')}` as ModuleId;
        nodes.push({
          id,
          topicId: topic.id,
          title: `Module ${m}`,
          ordinal: m,
          kind: 'module' as const,
          testOutEligible: false,
          estimatedMinutes: 20,
          state: m === 0 ? ('available' as const) : ('not-yet-recommended' as const),
          content: null,
        });
      }
      const graph: ModuleGraph = {
        topicId: topic.id,
        nodes,
        edges: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id })),
        entryModules: [nodes[0].id],
      };
      store.modules.upsertGraph(graph);
    }
  });

  afterAll(() => {
    closeStore(dataRoot);
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('seeds the declared scale', () => {
    expect(store.topics.list()).toHaveLength(TOPIC_COUNT);
  });

  it('issues exactly one query for topics.list()', () => {
    const probe = new Database(':memory:');
    const proto = Object.getPrototypeOf(probe.prepare('SELECT 1'));
    probe.close();

    let allCalls = 0;
    const original = proto.all;
    proto.all = function patchedAll(...args: unknown[]) {
      allCalls += 1;
      return original.apply(this, args);
    };
    try {
      const result = store.topics.list();
      expect(result).toHaveLength(TOPIC_COUNT);
    } finally {
      proto.all = original;
    }
    expect(allCalls).toBe(1);
  });

  it('completes the dashboard read under 300ms p95 over >=20 samples', () => {
    const samples: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const start = performance.now();
      const listed = store.topics.list();
      expect(listed).toHaveLength(TOPIC_COUNT);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p95Index = Math.ceil(0.95 * samples.length) - 1;
    const p95 = samples[p95Index];
    expect(p95).toBeLessThan(300);
  });
});
