// FRACTAL: covers F2 | type integration
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  exampleModuleContent,
  topicNoteSchema,
  type Topic,
} from '@/shapes';
import { resetConfigCache, saveConfig } from '@/core/config';
import { openStore, closeStore, type Store } from '@/store/open';
import type { NewTopic } from '@/store/topics';
import { SessionRunner } from '@/cli/run-session';
import { KindTransport } from '@/orchestrator/transport.kind';
import { createOrchestrator, type Orchestrator } from '@/orchestrator/engine';
import { planFor } from '@/orchestrator/plan';
import { readTopicState } from '@/orchestrator/topic-state';
import { crossTopicCandidates } from '@/orchestrator/discontinuity';
import { repairTargets } from '@/orchestrator/repair';
import { MAX_REPAIR_ROUNDS } from '@/orchestrator/repair.budget';

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

const plan = planFor(intake);

let dataRoot: string;
let store: Store;
let runner: SessionRunner;
let orchestrator: Orchestrator;
let reviewCalls: number;

function outline(count: number): unknown {
  const nodes = Array.from({ length: count }, (_v, i) => ({ id: `n${i}`, title: `Entropy lesson ${i + 1}` }));
  return {
    drivingQuestion: 'How small can a message get?',
    modules: nodes,
    edges: nodes.slice(1).map((n) => ({ from: 'n0', to: n.id })),
  };
}

const goodContent = {
  ...exampleModuleContent,
  // WHY the body: a lesson with no "blocks" is queued for repair by C4/repair, which would
  // make every fixture here look like a course that needed rewriting.
  blocks: [
    { kind: 'prose', markdown: 'The body of the test lesson.' },
    { kind: 'reveal', prompt: 'Work it out first.', answer: 'Like this.' },
  ],
  explanation: { kind: 'text', markdown: 'Real lesson.' },
};

function boot(review: () => unknown | 'fail' | 'hang'): void {
  reviewCalls = 0;
  runner = new SessionRunner({
    stallMs: 400,
    transport: new KindTransport({
      responder: (kind) => {
        if (kind === 'generate-topic') return outline(plan.estimatedModules);
        if (kind === 'capstone-spec') return { spec: 'Build it and defend it.' };
        if (kind === 'discontinuity-review') {
          reviewCalls += 1;
          return review();
        }
        return goodContent;
      },
    }),
  });
  orchestrator = createOrchestrator({ store, runner, dataRoot });
}

async function generate(topic: Topic): Promise<void> {
  orchestrator.enqueueTopic(topic.id);
  await orchestrator.drain();
  orchestrator.resumeGeneration(topic.id);
  await orchestrator.drain();
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-disc-'));
  process.env.LA_DATA_ROOT = dataRoot;
  resetConfigCache();
  saveConfig({
    dataRoot,
    claudeBin: 'claude',
  });
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

describe('F2 path: the discontinuity review finds a gap', () => {
  it('takes each finding back to the lesson it names instead of writing it on the page', async () => {
    boot(() => ({
      issues: [
        { message: 'Lesson 4 uses "entropy rate" before lesson 3 defines it.' },
        { message: 'Lesson 6 assumes you already met conditional probability.' },
      ],
    }));
    const topic = store.topics.create(intake);
    await generate(topic);

    // One check, then a round of fixes and another check, twice — the MAX_REPAIR_ROUNDS
    // ceiling. The reviewer here never relents, so the loop runs to that ceiling.
    expect(reviewCalls).toBe(1 + MAX_REPAIR_ROUNDS);
    const state = readTopicState(dataRoot, topic.id);
    expect(state.reviewRuns).toBe(1);

    // Nothing about the seams reaches the learner: they get a finished subject.
    expect(state.notes.filter((n) => n.kind === 'discontinuity')).toHaveLength(0);
    expect(state.status).toBe('ready');
    for (const note of state.notes) expect(() => topicNoteSchema.parse(note)).not.toThrow();
    // The topic stays fully usable: every lesson still has its content.
    expect(store.modules.graph(topic.id).nodes.every((n) => n.content !== null)).toBe(true);
  });

  it('stops re-checking when a round of fixes could not route a single finding', async () => {
    // No lesson number and no lesson title, so there is nothing to rewrite. Paying for
    // another check would buy the same answer.
    boot(() => ({ issues: [{ message: 'Something, somewhere, is a bit rough.' }] }));
    const topic = store.topics.create(intake);
    await generate(topic);

    expect(reviewCalls).toBe(1);
    expect(readTopicState(dataRoot, topic.id).notes.filter((n) => n.kind === 'discontinuity')).toHaveLength(0);
    expect(readTopicState(dataRoot, topic.id).status).toBe('ready');
  });

  it('is not run a second time when the same topic is generated again', async () => {
    boot(() => ({ issues: [{ message: 'One rough seam between lesson 2 and lesson 3.' }] }));
    const topic = store.topics.create(intake);
    await generate(topic);
    const afterFirstRun = reviewCalls;
    expect(afterFirstRun).toBeGreaterThan(0);
    orchestrator.resumeGeneration(topic.id);
    await orchestrator.drain();

    expect(reviewCalls).toBe(afterFirstRun);
    const state = readTopicState(dataRoot, topic.id);
    expect(state.reviewRuns).toBe(1);
    expect(state.notes.filter((n) => n.message.includes('rough seam'))).toHaveLength(0);
  });

  it("routes a finding by nothing but this topic's own lessons", () => {
    const graph = {
      topicId: 't_AAAAAAAAAAAAAAAA' as never,
      nodes: [
        { id: 'm_aaaaaaaaaaaaaaa1', ordinal: 1, title: 'Codes and code lengths' },
        { id: 'm_aaaaaaaaaaaaaaa2', ordinal: 2, title: 'Entropy as expected surprise' },
      ],
      edges: [],
      entryModules: [],
    } as never;

    // An id belonging to somewhere else, and a traversal dressed as one, are not addresses.
    expect(
      repairTargets(graph, { message: 'A seam here.', affectedModules: ['m_ZZZZZZZZZZZZZZZZ', '../../etc/passwd'] as never }),
    ).toEqual([]);
    // The reviewer mostly answers in prose, so the prose is read for addresses.
    expect(repairTargets(graph, { message: 'Lesson 2 leans on lesson 1.', affectedModules: [] })).toEqual([
      'm_aaaaaaaaaaaaaaa1',
      'm_aaaaaaaaaaaaaaa2',
    ]);
    expect(
      repairTargets(graph, { message: 'Entropy as expected surprise is never set up.', affectedModules: [] }),
    ).toEqual(['m_aaaaaaaaaaaaaaa2']);
  });
});

describe('F2 path: the discontinuity review itself fails', () => {
  it('leaves the topic usable with one note saying the check could not run', async () => {
    boot(() => 'fail');
    const topic = store.topics.create(intake);
    await generate(topic);

    expect(reviewCalls).toBe(1);
    const state = readTopicState(dataRoot, topic.id);
    expect(state.status).toBe('ready-with-notes');
    const note = state.notes.find((n) => n.message.includes('consistency check could not run'));
    expect(note).toBeDefined();
    expect(note?.message).toMatch(/still usable/);
    expect(note?.message).not.toMatch(/nonzero-exit|Error:|[A-Za-z]:\\/);
    // Nothing is blocked: every module kept its content.
    expect(store.modules.graph(topic.id).nodes.every((n) => n.content !== null)).toBe(true);
  });
});

describe('cross-topic connections', () => {
  it('surfaces another topic that shares ground, and never points at itself', async () => {
    boot(() => ({ issues: [] }));
    const other = store.topics.create({ ...intake, subject: 'Entropy and thermodynamics' });
    const topic = store.topics.create(intake);
    await generate(topic);

    const graph = store.modules.graph(topic.id);
    const notes = crossTopicCandidates(topic, [topic, other], graph);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((n) => n.kind === 'cross-topic')).toBe(true);
    expect(notes[0].message).toContain(other.subject);
    expect(crossTopicCandidates(topic, [topic], graph)).toEqual([]);

    const persisted = readTopicState(dataRoot, topic.id).notes;
    expect(persisted.some((n) => n.kind === 'cross-topic')).toBe(true);
  });
});
