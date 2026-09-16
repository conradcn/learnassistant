// FRACTAL: covers F12 | type unit
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
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
import { ensureTopicDir, readTopicState, setTopicStatus } from '@/orchestrator/topic-state';
import {
  EXTEND_BLOCKED_MESSAGE,
  EXTEND_UNPLANNED_MESSAGE,
  MAX_EXTENSION_MODULES,
  MIN_EXTENSION_MODULES,
  courseFrontier,
  extendAllowedForStatus,
  extensionSize,
  insertExtension,
  normalizeExtension,
  planExtension,
} from '@/orchestrator/extend';

const topicId = topicIdSchema.parse('t_9fQ2xK4mZa71bC0d');
const GOAL = 'Sufficient knowledge for the MCAT';

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

/** Three lessons in a chain, then the final project hanging off the last of them. */
function course(): ModuleGraph {
  const core = [node(1), node(2), node(3)];
  const capstone = node(4, { title: 'Project: Practical Biology', kind: 'capstone', state: 'not-yet-recommended' });
  return {
    topicId,
    nodes: [...core, capstone],
    edges: [
      { from: id(1), to: id(2) },
      { from: id(2), to: id(3) },
      { from: id(3), to: capstone.id },
    ],
    entryModules: [id(1)],
  };
}

const outline = {
  modules: [
    { title: 'Amino acids', objectives: ['Name them.'], estimatedMinutes: 20, testOutEligible: false },
    { title: 'Enzyme kinetics', objectives: ['Read the curve.'], estimatedMinutes: 20, testOutEligible: false },
  ],
  edges: [{ from: 0, to: 1 }],
  fallback: false,
};

describe('F12: how much course an extension buys', () => {
  it('sizes the addition from the goal, and stays between the floor and the ceiling', () => {
    expect(extensionSize('the MCAT')).toBe(MIN_EXTENSION_MODULES + 2);
    expect(extensionSize('a')).toBe(MIN_EXTENSION_MODULES);
    expect(extensionSize(GOAL)).toBeGreaterThan(extensionSize('the MCAT'));
    expect(extensionSize('word '.repeat(200))).toBe(MAX_EXTENSION_MODULES);
  });
});

describe('F12 happy path: a course is extended to a further goal', () => {
  const graph = course();
  const plan = planExtension(graph, outline);
  const grown = insertExtension(graph, plan);

  it('adds the new lessons past every existing ordinal and renumbers nothing', () => {
    expect(plan.nodes).toHaveLength(2);
    for (const before of graph.nodes) {
      if (before.kind === 'capstone') continue;
      const after = grown.nodes.find((n) => n.id === before.id);
      expect(after?.ordinal).toBe(before.ordinal);
      expect(after?.state).toBe(before.state);
      expect(after?.content).toBe(before.content);
    }
    for (const added of plan.nodes) {
      expect(added.ordinal).toBeGreaterThan(3);
      expect(added.kind).toBe('module');
      expect(added.content).toBeNull();
    }
    expect(() => moduleGraphSchema.parse(grown)).not.toThrow();
  });

  it('hangs the extension off the end of the course, not off nothing', () => {
    expect(courseFrontier(graph)).toEqual([id(3)]);
    const entry = plan.nodes[0];
    expect(plan.edges).toContainEqual({ from: id(3), to: entry.id });
    // The second new lesson follows the first, so the course's end is not its prerequisite.
    expect(plan.edges).toContainEqual({ from: entry.id, to: plan.nodes[1].id });
    expect(plan.edges).not.toContainEqual({ from: id(3), to: plan.nodes[1].id });
  });

  it('moves the final project behind the lessons that were just added', () => {
    const capstone = grown.nodes.find((n) => n.kind === 'capstone');
    if (capstone === undefined) throw new Error('the capstone went missing');
    const into = grown.edges.filter((e) => e.to === capstone.id).map((e) => e.from);
    expect(into).toEqual([plan.nodes[1].id]);
    expect(into).not.toContain(id(3));
    expect(capstone.ordinal).toBeGreaterThan(Math.max(...plan.nodes.map((n) => n.ordinal)));
  });

  it('leaves a course with no final project alone rather than inventing one', () => {
    const bare: ModuleGraph = { topicId, nodes: [node(1)], edges: [], entryModules: [id(1)] };
    const added = insertExtension(bare, planExtension(bare, outline));
    expect(added.nodes.some((n) => n.kind === 'capstone')).toBe(false);
    expect(added.nodes).toHaveLength(3);
  });
});

describe('F12 path: the extension proposes lessons the course already has', () => {
  it('drops the duplicates, keeps the count, and re-points the edges it kept', () => {
    const normalized = normalizeExtension(
      GOAL,
      4,
      {
        modules: [
          { title: 'Lesson 1' },
          { title: 'Amino acids' },
          { title: 'lesson 2  ' },
          { title: 'Enzyme kinetics' },
        ],
        edges: [{ fromIndex: 1, toIndex: 3 }, { fromIndex: 0, toIndex: 1 }],
      },
      ['Lesson 1', 'Lesson 2', 'Lesson 3'],
    );
    expect(normalized.modules).toHaveLength(4);
    expect(normalized.modules.map((m) => m.title).slice(0, 2)).toEqual(['Amino acids', 'Enzyme kinetics']);
    expect(normalized.modules.map((m) => m.title)).not.toContain('Lesson 1');
    // The edge between the two lessons it kept survives, remapped to their new positions.
    expect(normalized.edges).toEqual([{ from: 0, to: 1 }]);
    expect(normalized.fallback).toBe(false);
  });

  it('falls back to a split by subtopic when nothing usable comes back', () => {
    const normalized = normalizeExtension(GOAL, 5, { modules: [] }, ['Lesson 1']);
    expect(normalized.fallback).toBe(true);
    expect(normalized.modules).toHaveLength(5);
    for (const m of normalized.modules) expect(m.title).toContain(GOAL);
  });
});

describe('F12: which subjects may be extended at all', () => {
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
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-extend-'));
    process.env.LA_DATA_ROOT = dataRoot;
    resetConfigCache();
    saveConfig({ dataRoot, claudeBin: 'claude' });
    store = openStore(dataRoot);
    runner = new SessionRunner({
      transport: new KindTransport({
        responder: (kind) =>
          kind === 'extend'
            ? {
                modules: [
                  { title: 'Amino acids and the peptide bond' },
                  { title: 'Enzyme kinetics under saturation' },
                ],
                edges: [{ fromIndex: 0, toIndex: 1 }],
              }
            : 'fail',
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

  function seed(status: Parameters<typeof setTopicStatus>[2]): ReturnType<Store['topics']['create']> {
    const topic = store.topics.create(intake);
    const first = node(1, { topicId: topic.id });
    store.modules.upsertGraph({ topicId: topic.id, nodes: [first], edges: [], entryModules: [first.id] });
    ensureTopicDir(dataRoot, topic.id);
    setTopicStatus(dataRoot, topic.id, status);
    return topic;
  }

  it('knows which statuses may be extended', () => {
    expect(extendAllowedForStatus('ready')).toBe(true);
    expect(extendAllowedForStatus('done')).toBe(true);
    // Unlike a detour: a healthy research pass hands a subject back exactly here.
    expect(extendAllowedForStatus('needs-attention')).toBe(true);
    expect(extendAllowedForStatus('queued')).toBe(false);
    expect(extendAllowedForStatus('generating')).toBe(false);
  });

  it('declines while a run is under way, with the reason stated and nothing queued', () => {
    const topic = seed('generating');
    let thrown: unknown = null;
    try {
      orchestrator.requestExtension({ topicId: topic.id, goal: GOAL });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('conflict');
    expect((thrown as AppError).message).toBe(EXTEND_BLOCKED_MESSAGE);
    expect(store.modules.graph(topic.id).nodes).toHaveLength(1);
    expect(readTopicState(dataRoot, topic.id).extensions).toEqual([]);
  });

  it('declines a subject that has no lessons to extend yet', () => {
    const topic = store.topics.create(intake);
    ensureTopicDir(dataRoot, topic.id);
    setTopicStatus(dataRoot, topic.id, 'needs-attention');
    let thrown: unknown = null;
    try {
      orchestrator.requestExtension({ topicId: topic.id, goal: GOAL });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).message).toBe(EXTEND_UNPLANNED_MESSAGE);
  });

  it('plans the extra lessons, records the goal, and hands the subject back for writing', async () => {
    const topic = seed('ready');
    const job = orchestrator.requestExtension({ topicId: topic.id, goal: GOAL });
    expect(job.kind).toBe('extend');
    // The goal is on the page from the press, before anything has been planned for it.
    expect(readTopicState(dataRoot, topic.id).extensions).toEqual([
      expect.objectContaining({ goal: GOAL, modulesAdded: 0 }),
    ]);

    await orchestrator.drain();

    const graph = store.modules.graph(topic.id);
    const titles = graph.nodes.map((n) => n.title);
    expect(titles).toContain('Amino acids and the peptide bond');
    expect(titles).toContain('Enzyme kinetics under saturation');
    expect(graph.nodes).toHaveLength(1 + extensionSize(GOAL));
    // Every new lesson is unwritten: this pass plans, the writing pass writes.
    for (const added of graph.nodes.filter((n) => n.id !== id(1))) expect(added.content).toBeNull();

    const state = readTopicState(dataRoot, topic.id);
    expect(state.extensions[0].modulesAdded).toBe(extensionSize(GOAL));
    expect(state.status).toBe('needs-attention');
  });

  it('keeps the course when research for the extension fails, and says the plan is a fallback', async () => {
    await runner.close();
    runner = new SessionRunner({ transport: new KindTransport({ responder: () => 'fail' }) });
    await orchestrator.close();
    orchestrator = createOrchestrator({ store, runner, dataRoot });

    const topic = seed('ready');
    orchestrator.requestExtension({ topicId: topic.id, goal: GOAL });
    await orchestrator.drain();

    const graph = store.modules.graph(topic.id);
    expect(graph.nodes.length).toBe(1 + extensionSize(GOAL));
    expect(graph.nodes.find((n) => n.id === id(1))?.title).toBe('Lesson 1');
    const notes = readTopicState(dataRoot, topic.id).notes;
    expect(notes.some((n) => n.message.includes('split up by subtopic'))).toBe(true);
  });
});
