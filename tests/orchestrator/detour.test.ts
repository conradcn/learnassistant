// FRACTAL: covers F12 | type unit
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  exampleModuleContent,
  exampleTopicIntakeRequest,
  moduleGraphSchema,
  moduleIdSchema,
  topicIdSchema,
  type ModuleGraph,
  type ModuleId,
  type ModuleNode,
} from '@/shapes';
import { AppError } from '@/core/errors';
import { resetConfigCache, saveConfig } from '@/core/config';
import { openStore, closeStore, type Store } from '@/store/open';
import type { NewTopic } from '@/store/topics';
import { SessionRunner } from '@/cli/run-session';
import { KindTransport } from '@/orchestrator/transport.kind';
import { createOrchestrator, type Orchestrator } from '@/orchestrator/engine';
import { ensureTopicDir, setTopicStatus } from '@/orchestrator/topic-state';
import { exampleDetourRequest, detourRequestSchema, type DetourRequest } from '@/orchestrator/plan';
import {
  DETOUR_BLOCKED_MESSAGE,
  abandonDetour,
  checkDetourInsertion,
  coreProgress,
  detourAllowedForStatus,
  insertDetour,
  nextOrdinal,
  planDetour,
} from '@/orchestrator/detour';

const topicId = topicIdSchema.parse('t_9fQ2xK4mZa71bC0d');

function id(n: number): ModuleId {
  return moduleIdSchema.parse(`m_${String(n).padStart(16, '0')}`);
}

function node(n: number, over: Partial<ModuleNode> = {}): ModuleNode {
  return {
    id: id(n),
    topicId,
    title: `Lesson ${n}`,
    ordinal: n,
    kind: 'module',
    testOutEligible: false,
    estimatedMinutes: 20,
    state: 'available',
    content: null,
    ...over,
  };
}

function chain(count: number): ModuleGraph {
  const nodes = Array.from({ length: count }, (_v, i) => node(i + 1));
  return {
    topicId,
    nodes,
    edges: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id })),
    entryModules: [nodes[0].id],
  };
}

const req: DetourRequest = detourRequestSchema.parse({
  ...exampleDetourRequest,
  topicId,
  anchorModuleId: id(2),
});

describe('F12 happy path: a detour is inserted off the module the learner was in', () => {
  const graph = chain(4);
  const plan = planDetour(graph, req);

  it('attaches the detour to the anchor and to nothing else', () => {
    expect(plan.edges).toEqual([{ from: id(2), to: plan.node.id }]);
    expect(plan.node.kind).toBe('detour');
    expect(plan.node.title).toContain(req.question);
    expect(checkDetourInsertion(graph, plan)).toEqual({ ok: true });
  });

  it('never becomes a prerequisite of a module that already exists', () => {
    const inserted = insertDetour(graph, plan);
    const outgoing = inserted.edges.filter((e) => e.from === plan.node.id);
    expect(outgoing).toEqual([]);
    for (const existing of graph.nodes) {
      expect(inserted.edges).not.toContainEqual({ from: plan.node.id, to: existing.id });
    }
  });

  it('renumbers nothing — every existing module keeps its ordinal, state and edges', () => {
    const inserted = insertDetour(graph, plan);
    for (const before of graph.nodes) {
      const after = inserted.nodes.find((n) => n.id === before.id);
      expect(after?.ordinal).toBe(before.ordinal);
      expect(after?.state).toBe(before.state);
    }
    for (const edge of graph.edges) expect(inserted.edges).toContainEqual(edge);
    expect(plan.node.ordinal).toBe(nextOrdinal(graph));
    expect(plan.node.ordinal).toBeGreaterThan(Math.max(...graph.nodes.map((n) => n.ordinal)));
    expect(() => moduleGraphSchema.parse(inserted)).not.toThrow();
  });

  it('refuses an insertion that would make the detour a prerequisite of an existing lesson', () => {
    const hostile = { ...plan, edges: [...plan.edges, { from: plan.node.id, to: id(3) }] };
    const check = checkDetourInsertion(graph, hostile);
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error('expected a refusal');
    expect(check.reason).toBe('prereq-of-existing');
    expect(() => insertDetour(graph, hostile)).toThrow(AppError);
  });

  it('refuses an anchor that is not part of this topic', () => {
    expect(() => planDetour(graph, { ...req, anchorModuleId: id(99) })).toThrow(AppError);
  });
});

describe('F12 path: the learner abandons the detour partway', () => {
  it('detaches the detour and leaves core progress exactly as it was', () => {
    const graph = chain(4);
    const withProgress: ModuleGraph = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.ordinal <= 2 ? { ...n, state: 'completed' as const } : n)),
    };
    const plan = planDetour(withProgress, req);
    const inserted = insertDetour(withProgress, plan);
    const before = coreProgress(inserted);

    const abandoned = abandonDetour(inserted, plan.node.id);
    expect(abandoned.edges.some((e) => e.from === plan.node.id || e.to === plan.node.id)).toBe(false);
    expect(coreProgress(abandoned)).toEqual(before);
    expect(coreProgress(abandoned)).toEqual({ completed: 2, total: 4 });
    for (const original of withProgress.nodes) {
      const after = abandoned.nodes.find((n) => n.id === original.id);
      expect(after?.ordinal).toBe(original.ordinal);
      expect(after?.state).toBe(original.state);
    }
  });

  it('refuses to abandon a module that is not a detour', () => {
    const graph = chain(3);
    expect(() => abandonDetour(graph, id(2))).toThrow(AppError);
  });
});

describe('F12 path: a detour is asked for while the topic needs attention', () => {
  const intake: NewTopic = {
    subject: exampleTopicIntakeRequest.subject,
    level: exampleTopicIntakeRequest.level,
    purpose: exampleTopicIntakeRequest.purpose,
    diagnostic: null,
  };
  let dataRoot: string;
  let store: Store;
  let runner: SessionRunner;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-detour-'));
    process.env.LA_DATA_ROOT = dataRoot;
    resetConfigCache();
    saveConfig({
      dataRoot,
      claudeBin: 'claude',
    });
    store = openStore(dataRoot);
    runner = new SessionRunner({
      transport: new KindTransport({
        responder: () => ({ ...exampleModuleContent, explanation: { kind: 'text', markdown: 'Side trip.' } }),
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

  it('knows which statuses may take a side trip at all', () => {
    expect(detourAllowedForStatus('ready')).toBe(true);
    expect(detourAllowedForStatus('ready-with-notes')).toBe(true);
    expect(detourAllowedForStatus('needs-attention')).toBe(false);
    expect(detourAllowedForStatus('queued')).toBe(false);
    expect(detourAllowedForStatus('generating')).toBe(false);
  });

  it('declines with the reason stated and queues nothing', () => {
    const topic = store.topics.create(intake);
    const anchor = node(1, { topicId: topic.id, id: id(1) });
    store.modules.upsertGraph({ topicId: topic.id, nodes: [anchor], edges: [], entryModules: [anchor.id] });
    ensureTopicDir(dataRoot, topic.id);
    setTopicStatus(dataRoot, topic.id, 'needs-attention');
    let thrown: unknown = null;
    try {
      orchestrator.requestDetour({ ...req, topicId: topic.id, anchorModuleId: anchor.id });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppError);
    const error = thrown as AppError;
    expect(error.code).toBe('conflict');
    expect(error.message).toBe(DETOUR_BLOCKED_MESSAGE);
    expect(error.message).toMatch(/Finish or retry/);
    expect(store.modules.graph(topic.id).nodes).toHaveLength(1);
  });

  it('accepts the same request once the topic is ready, and queues exactly one job', async () => {
    const topic = store.topics.create(intake);
    const anchor = node(1, { topicId: topic.id, id: id(1) });
    store.modules.upsertGraph({ topicId: topic.id, nodes: [anchor], edges: [], entryModules: [anchor.id] });
    ensureTopicDir(dataRoot, topic.id);
    setTopicStatus(dataRoot, topic.id, 'ready');
    const job = orchestrator.requestDetour({ ...req, topicId: topic.id, anchorModuleId: anchor.id });
    expect(job.kind).toBe('detour');
    expect(job.status).toBe('queued');

    const graph = store.modules.graph(topic.id);
    expect(graph.nodes.filter((n) => n.kind === 'detour')).toHaveLength(1);
    expect(graph.nodes.find((n) => n.id === anchor.id)?.ordinal).toBe(anchor.ordinal);

    await orchestrator.drain();
    const detour = store.modules.graph(topic.id).nodes.find((n) => n.kind === 'detour');
    expect(detour?.content).not.toBeNull();
  });

  it('says which lesson is being written before the writing starts, not only once it is over', async () => {
    const topic = store.topics.create(intake);
    const anchor = node(1, { topicId: topic.id, id: id(1) });
    store.modules.upsertGraph({ topicId: topic.id, nodes: [anchor], edges: [], entryModules: [anchor.id] });
    ensureTopicDir(dataRoot, topic.id);
    setTopicStatus(dataRoot, topic.id, 'ready');

    const ticks: { phase: string; currentModule: string | null }[] = [];
    const watching = (async () => {
      for await (const p of orchestrator.subscribe(topic.id)) {
        ticks.push({ phase: p.phase, currentModule: p.currentModule });
        if (p.phase === 'done') break;
      }
    })();
    orchestrator.requestDetour({ ...req, topicId: topic.id, anchorModuleId: anchor.id });
    await orchestrator.drain();
    await watching;

    const detour = store.modules.graph(topic.id).nodes.find((n) => n.kind === 'detour');
    const announced = ticks.findIndex((t) => t.phase === 'authoring' && t.currentModule === detour?.title);
    expect(announced).toBeGreaterThanOrEqual(0);
    expect(announced).toBeLessThan(ticks.findIndex((t) => t.phase === 'done'));
  });
});
