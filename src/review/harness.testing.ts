// FRACTAL: implements F7, F8 | component C7
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  exampleEvalScript,
  exampleModuleContent,
  isoDateStringSchema,
  type EvalScript,
  type ISODateString,
  type ModuleId,
  type ModuleNode,
  type PrereqEdge,
  type Topic,
} from '@/shapes';
import { assertNotInRelease } from '@/core/release';
import { resetConfigCache, saveConfig } from '@/core/config';
import { closeStore, openStore, type Store } from '@/store/open';
import { createPracticeStore, type PracticeStore } from '@/practice/store';
import { scheduleOnCompletion } from '@/review/schedule';

assertNotInRelease('review/harness.testing');

export type C7Harness = {
  dataRoot: string;
  store: Store;
  practice: PracticeStore;
  teardown(): void;
};

export const NOW: ISODateString = isoDateStringSchema.parse('2030-01-01T00:00:00.000Z');

export function at(days: number, from: ISODateString = NOW): ISODateString {
  return isoDateStringSchema.parse(
    new Date(Date.parse(from) + days * 24 * 60 * 60 * 1000).toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z'),
  );
}

export function bootC7(): C7Harness {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-c7-'));
  process.env.LA_DATA_ROOT = dataRoot;
  resetConfigCache();
  saveConfig({ dataRoot, claudeBin: 'claude' });
  const store = openStore(dataRoot);
  return {
    dataRoot,
    store,
    practice: createPracticeStore(),
    teardown(): void {
      closeStore(dataRoot);
      delete process.env.LA_DATA_ROOT;
      resetConfigCache();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

export type SeedOptions = {
  subject?: string;
  titles?: string[];
  completed?: number;
  script?: EvalScript;
  idPrefix?: string;
  schedule?: boolean;
};

let seedCounter = 0;

export function seedCompletedTopic(store: Store, opts?: SeedOptions): { topic: Topic; nodes: ModuleNode[] } {
  seedCounter += 1;
  const prefix = opts?.idPrefix ?? String(seedCounter).padStart(2, '0');
  const topic = store.topics.create({
    subject: opts?.subject ?? 'Information theory',
    level: 'intermediate',
    purpose: 'build a compressor with an agent',
    diagnostic: null,
  });
  const titles = opts?.titles ?? ['Entropy as expected surprise', 'Codes and lengths'];
  const completed = opts?.completed ?? titles.length;
  const nodes: ModuleNode[] = titles.map((title, i) => ({
    id: `m_${prefix}${String(i).padStart(14, '0')}` as ModuleId,
    topicId: topic.id,
    title,
    ordinal: i + 1,
    kind: 'module',
    testOutEligible: true,
    estimatedMinutes: 20,
    state: i < completed ? 'completed' : 'available',
    content: { ...exampleModuleContent, evalScript: opts?.script ?? exampleEvalScript },
  }));
  const edges: PrereqEdge[] = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id }));
  store.modules.upsertGraph({ topicId: topic.id, nodes, edges, entryModules: [nodes[0].id] });
  if (opts?.schedule !== false) {
    for (const node of nodes.slice(0, completed)) scheduleOnCompletion(store, node.id, 0, NOW);
  }
  return { topic, nodes };
}
