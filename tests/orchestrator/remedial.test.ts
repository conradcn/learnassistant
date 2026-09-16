// FRACTAL: covers F4 | type unit
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  exampleModuleContent,
  exampleTopicIntakeRequest,
  moduleIdSchema,
  type ModuleId,
  type ModuleNode,
} from '@/shapes';
import { resetConfigCache, saveConfig } from '@/core/config';
import { openStore, closeStore, type Store } from '@/store/open';
import type { NewTopic } from '@/store/topics';
import { SessionRunner } from '@/cli/run-session';
import { KindTransport } from '@/orchestrator/transport.kind';
import { createOrchestrator, type Orchestrator } from '@/orchestrator/engine';
import { ensureTopicDir, setTopicStatus } from '@/orchestrator/topic-state';

function id(n: number): ModuleId {
  return moduleIdSchema.parse(`m_${String(n).padStart(16, '0')}`);
}

describe('F4 mastery-learning correction: the remedial lesson is actually written', () => {
  const intake: NewTopic = { ...exampleTopicIntakeRequest, diagnostic: null };
  let dataRoot: string;
  let store: Store;
  let runner: SessionRunner;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-remedial-'));
    process.env.LA_DATA_ROOT = dataRoot;
    resetConfigCache();
    saveConfig({
      dataRoot,
      claudeBin: 'claude',
    });
    store = openStore(dataRoot);
    runner = new SessionRunner({
      transport: new KindTransport({
        responder: () => ({ ...exampleModuleContent, explanation: { kind: 'text', markdown: 'Closer look.' } }),
      }),
    });
    orchestrator = createOrchestrator({ store, runner, dataRoot });
  });

  afterEach(async () => {
    await orchestrator.close();
    await runner.close();
    closeStore(dataRoot);
    delete process.env.LA_DATA_ROOT;
    resetConfigCache();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('writes the remedial lesson it queued, instead of refusing its own authorisation', async () => {
    const topic = store.topics.create(intake);
    const anchor: ModuleNode = {
      id: id(1), topicId: topic.id, title: 'Lesson 1', ordinal: 1, kind: 'module',
      testOutEligible: false, estimatedMinutes: 20, state: 'available', content: exampleModuleContent,
    };
    store.modules.upsertGraph({ topicId: topic.id, nodes: [anchor], edges: [], entryModules: [anchor.id] });
    ensureTopicDir(dataRoot, topic.id);
    setTopicStatus(dataRoot, topic.id, 'ready');
    const job = orchestrator.requestRemedial(anchor.id, 'unit circle signs');

    // WHY the kind is asserted: the queue dispatches by job kind, so a detour queued
    // under any other kind never runs and the "A closer look at…" node sits in the graph
    // permanently unwritten.
    expect(job.kind).toBe('detour');

    await orchestrator.drain();
    const remedial = store.modules.graph(topic.id).nodes.find((n) => n.kind === 'remedial');
    expect(remedial).toBeDefined();
    expect(remedial?.content).not.toBeNull();
  });
});
