// FRACTAL: covers F2 | type integration
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  exampleModuleContent,
  moduleContentSchema,
  moduleGraphSchema,
  type ModuleGraph,
  type Topic,
} from '@/shapes';
import { resetConfigCache, saveConfig } from '@/core/config';
import { openStore, closeStore, type Store } from '@/store/open';
import type { NewTopic } from '@/store/topics';
import { SessionRunner } from '@/cli/run-session';
import { KindTransport } from '@/orchestrator/transport.kind';
import { createOrchestrator, type Orchestrator } from '@/orchestrator/engine';
import { planFor } from '@/orchestrator/plan';
import { MAX_PREP_MODULES, prepWindow } from '@/orchestrator/prep-window';
import { readTopicState } from '@/orchestrator/topic-state';
import { TUTOR_PROPOSES_OBJECTIVE } from '@/orchestrator/capstone-spec';
import { findCycle, entryModulesOf, unreachableFrom } from '@/orchestrator/discontinuity';

// WHY this subject rather than the shared example intake: these paths are about what one
// authoring pass does, and C4 now writes one prep window per pass (@/orchestrator/prep-window).
// A subject that fits inside a single window keeps "the pass" and "the course" the same
// thing here; the multi-pass behaviour has its own tests.
const intake: NewTopic = {
  subject: 'Knots',
  level: 'beginner',
  purpose: 'tie',
  diagnostic: null,
};

type Shape = 'wide' | 'linear' | 'research-fails';

let dataRoot: string;
let store: Store;
let runner: SessionRunner;
let orchestrator: Orchestrator;
let seenKinds: string[];

function outlineFor(shape: Shape, count: number): unknown {
  const nodes = Array.from({ length: count }, (_v, i) => ({
    id: `n${i}`,
    title: `Lesson about part ${i + 1}`,
    objectives: [`Explain part ${i + 1}`],
  }));
  const edges =
    shape === 'linear'
      ? nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id }))
      : nodes.slice(1).map((n) => ({ from: nodes[0].id, to: n.id }));
  return { drivingQuestion: 'What is really going on here?', modules: nodes, edges };
}

function makeResponder(shape: Shape, count: number) {
  return (kind: string): unknown => {
    seenKinds.push(kind);
    if (kind === 'generate-topic') {
      return shape === 'research-fails' ? 'fail' : outlineFor(shape, count);
    }
    if (kind === 'capstone-spec') return { spec: 'Build the thing and justify every choice.' };
    if (kind === 'discontinuity-review') return { issues: [] };
    return {
      ...exampleModuleContent,
  // WHY the body: a lesson with no "blocks" is queued for repair by C4/repair, which would
  // make every fixture here look like a course that needed rewriting.
  blocks: [
    { kind: 'prose', markdown: 'The body of the test lesson.' },
    { kind: 'reveal', prompt: 'Work it out first.', answer: 'Like this.' },
  ],
      explanation: { kind: 'text', markdown: 'Written for the test.' },
    };
  };
}

function boot(shape: Shape, count: number): void {
  seenKinds = [];
  runner = new SessionRunner({ transport: new KindTransport({ responder: makeResponder(shape, count) }) });
  orchestrator = createOrchestrator({ store, runner, dataRoot });
}

async function generate(topic: Topic): Promise<{ graph: ModuleGraph; totalSessions: number }> {
  orchestrator.enqueueTopic(topic.id);
  await orchestrator.drain();
  orchestrator.resumeGeneration(topic.id);
  await orchestrator.drain();
  return { graph: store.modules.graph(topic.id), totalSessions: orchestrator.sessionsDispatchedFor(topic.id) };
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-gen-'));
  process.env.LA_DATA_ROOT = dataRoot;
  resetConfigCache();
  saveConfig({ dataRoot, claudeBin: 'claude' });
  store = openStore(dataRoot);
});

afterEach(async () => {
  await orchestrator.close();
  await runner.close();
  closeStore(dataRoot);
  delete process.env.LA_DATA_ROOT;
  resetConfigCache();
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('F2 happy path: a branching graph generates end to end', () => {
  it('dispatches exactly planFor().sessionCount sessions and finishes ready', async () => {
    const plan = planFor(intake);
    boot('wide', plan.estimatedModules);
    const topic = store.topics.create(intake);
    const { graph, totalSessions } = await generate(topic);

    expect(totalSessions).toBe(plan.sessionCount);
    expect(seenKinds.filter((k) => k === 'author-module')).toHaveLength(plan.estimatedModules);
    expect(seenKinds.filter((k) => k === 'capstone-spec')).toHaveLength(1);
    // AC: the discontinuity review runs exactly once, after all modules.
    expect(seenKinds.filter((k) => k === 'discontinuity-review')).toHaveLength(1);
    expect(seenKinds.indexOf('discontinuity-review')).toBe(seenKinds.length - 1);

    expect(readTopicState(dataRoot, topic.id).status).toBe('ready');
    expect(() => moduleGraphSchema.parse(graph)).not.toThrow();
  });

  it('gives every module goals, a warm-up, an explanation and an evaluation before ready', async () => {
    const plan = planFor(intake);
    boot('wide', plan.estimatedModules);
    const topic = store.topics.create(intake);
    const { graph } = await generate(topic);

    expect(readTopicState(dataRoot, topic.id).status).toBe('ready');
    for (const node of graph.nodes) {
      expect(node.content, node.title).not.toBeNull();
      const content = moduleContentSchema.parse(node.content);
      expect(content.learningGoals.length).toBeGreaterThan(0);
      expect(content.warmUp.prompt.length).toBeGreaterThan(0);
      expect(content.explanation.kind === 'text' || content.explanation.kind === 'video').toBe(true);
      expect(content.evalScript).toBeDefined();
    }
  });

  it('stores explicit prerequisite edges, is acyclic, and has at least one entry module', async () => {
    const plan = planFor(intake);
    boot('wide', plan.estimatedModules);
    const topic = store.topics.create(intake);
    const { graph } = await generate(topic);

    expect(graph.edges.length).toBeGreaterThan(0);
    expect(findCycle(graph.nodes, graph.edges)).toBeNull();
    const entry = entryModulesOf(graph.nodes, graph.edges);
    expect(entry.length).toBeGreaterThanOrEqual(1);
    expect(graph.entryModules.length).toBeGreaterThanOrEqual(1);
    expect(unreachableFrom(graph.nodes, graph.edges, entry)).toEqual([]);
    // AC: several modules are available at once — this is a graph, not a chain.
    const openAtOnce = graph.nodes.filter((n) => !graph.edges.some((e) => e.to === n.id));
    expect(openAtOnce.length).toBeGreaterThanOrEqual(1);
    const secondWave = graph.edges.filter((e) => e.from === entry[0]).length;
    expect(secondWave).toBeGreaterThanOrEqual(2);
  });

  it('authors a capstone spec that references the driving question and the purpose', async () => {
    const plan = planFor(intake);
    boot('wide', plan.estimatedModules);
    const topic = store.topics.create(intake);
    const { graph } = await generate(topic);

    const capstone = graph.nodes.find((n) => n.kind === 'capstone');
    expect(capstone).toBeDefined();
    const content = moduleContentSchema.parse(capstone?.content);
    expect(content.explanation.kind).toBe('text');
    if (content.explanation.kind !== 'text') throw new Error('capstone explanation must be text');
    const drivingQuestion = readTopicState(dataRoot, topic.id).drivingQuestion ?? '';
    expect(drivingQuestion.length).toBeGreaterThan(0);
    expect(content.explanation.markdown).toContain(drivingQuestion);
    expect(content.explanation.markdown).toContain(intake.purpose);
  });

  it('asks the capstone session to propose the project itself, and keeps the one it proposes', async () => {
    const plan = planFor(intake);
    const prompts: string[] = [];
    const respond = makeResponder('wide', plan.estimatedModules);
    seenKinds = [];
    runner = new SessionRunner({
      transport: new KindTransport({
        responder: (kind, prompt) => {
          if (kind === 'capstone-spec') prompts.push(prompt);
          return respond(kind);
        },
      }),
    });
    orchestrator = createOrchestrator({ store, runner, dataRoot });
    const topic = store.topics.create(intake);
    const { graph } = await generate(topic);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(TUTOR_PROPOSES_OBJECTIVE);
    // 'tie' is too vague a purpose to build against, and the session was asked for a
    // synthesis problem instead — the problem it wrote is the brief, not the template.
    const content = moduleContentSchema.parse(graph.nodes.find((n) => n.kind === 'capstone')?.content);
    if (content.explanation.kind !== 'text') throw new Error('capstone explanation must be text');
    expect(content.explanation.markdown).toContain('Build the thing and justify every choice.');
  });
});

describe('F2 path: a strictly linear subject produces a chain, with no artificial branches', () => {
  it('keeps the chain the research session proposed', async () => {
    const plan = planFor(intake);
    boot('linear', plan.estimatedModules);
    const topic = store.topics.create(intake);
    const { graph } = await generate(topic);

    const modules = graph.nodes.filter((n) => n.kind === 'module').sort((a, b) => a.ordinal - b.ordinal);
    expect(modules).toHaveLength(plan.estimatedModules);
    for (let i = 1; i < modules.length; i += 1) {
      expect(graph.edges).toContainEqual({ from: modules[i - 1].id, to: modules[i].id });
    }
    expect(entryModulesOf(modules, graph.edges)).toEqual([modules[0].id]);
    expect(findCycle(graph.nodes, graph.edges)).toBeNull();
  });
});

describe('F2 path: research finds no suitable outline', () => {
  it('falls back to a generic decomposition by subtopic, keeps generating, and says so', async () => {
    const plan = planFor(intake);
    boot('research-fails', plan.estimatedModules);
    const topic = store.topics.create(intake);
    const { graph, totalSessions } = await generate(topic);

    const modules = graph.nodes.filter((n) => n.kind === 'module');
    expect(modules).toHaveLength(plan.estimatedModules);
    expect(totalSessions).toBe(plan.sessionCount);
    for (const node of modules) expect(node.content).not.toBeNull();

    const state = readTopicState(dataRoot, topic.id);
    expect(state.status).toBe('ready-with-notes');
    const note = state.notes.find((n) => n.message.includes('Could not research an outline'));
    expect(note).toBeDefined();
    expect(note?.message).toMatch(/split up by subtopic/);
    // The learner is never shown a raw error code or a stack trace.
    expect(note?.message).not.toMatch(/nonzero-exit|Error:|undefined/);
  });
});

/**
 * WHY (F2): the plan is allowed to be a degree's worth of lessons — "high school biology to
 * MCAT-ready" is a real request — but preparing all of it before the learner has read the
 * first lesson spends every session up front on material they may never reach. C4 writes one
 * prep window per pass, and the subject page offers the next pass with its own cost. What is
 * bounded is the lookahead; the course is not.
 */
describe('F2 path: a course longer than one prep window', () => {
  const bigIntake: NewTopic = {
    subject: 'Molecular biology genetics physiology biochemistry organic chemistry',
    level: 'advanced',
    purpose: 'sit the admissions exam having understood the material rather than crammed it',
    diagnostic: null,
  };

  async function pass(topic: Topic): Promise<number> {
    orchestrator.resumeGeneration(topic.id);
    await orchestrator.drain();
    return store.modules.graph(topic.id).nodes.filter((n) => n.kind === 'module' && n.content !== null).length;
  }

  it('plans the whole course, prepares a window of it, and leaves the rest for the next pass', async () => {
    const plan = planFor(bigIntake);
    // The fixture has to outrun one window for there to be a remainder to test at all.
    expect(plan.estimatedModules).toBeGreaterThan(MAX_PREP_MODULES);
    boot('wide', plan.estimatedModules);
    const topic = store.topics.create(bigIntake);
    orchestrator.enqueueTopic(topic.id);
    await orchestrator.drain();

    // The whole course is planned — the plan is what the learner asked for.
    expect(store.modules.graph(topic.id).nodes.filter((n) => n.kind === 'module')).toHaveLength(plan.estimatedModules);

    const afterFirst = await pass(topic);
    expect(afterFirst).toBe(MAX_PREP_MODULES);
    // The check reads the course as a whole, so it waits until there is a whole course.
    expect(seenKinds.filter((k) => k === 'discontinuity-review')).toHaveLength(0);
    expect(readTopicState(dataRoot, topic.id).status).toMatch(/^ready/);

    let written = afterFirst;
    for (let i = 0; i < 10 && written < plan.estimatedModules; i += 1) written = await pass(topic);
    expect(written).toBe(plan.estimatedModules);

    // Spread over passes, the course still costs exactly what the plan quoted at intake.
    expect(seenKinds.filter((k) => k === 'discontinuity-review')).toHaveLength(1);
    expect(seenKinds.filter((k) => k === 'capstone-spec')).toHaveLength(1);
    expect(orchestrator.sessionsDispatchedFor(topic.id)).toBe(plan.sessionCount);
  });

  it('never writes more than one window of lessons at a time', async () => {
    const plan = planFor(bigIntake);
    boot('wide', plan.estimatedModules);
    const topic = store.topics.create(bigIntake);
    orchestrator.enqueueTopic(topic.id);
    await orchestrator.drain();

    // The window the next pass will write is bounded, however long the course is.
    expect(prepWindow(store.modules.graph(topic.id))).toHaveLength(MAX_PREP_MODULES);
    // No consistency check runs on a pass that leaves lessons unwritten.
    expect(seenKinds.filter((k) => k === 'discontinuity-review')).toHaveLength(0);
  });
});
