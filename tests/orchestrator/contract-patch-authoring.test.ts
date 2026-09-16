// FRACTAL: covers F2, F12 | type integration | path authoring-misses-the-contract
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exampleModuleContent, type Topic } from '@/shapes';
import { resetConfigCache, saveConfig } from '@/core/config';
import { openStore, closeStore, type Store } from '@/store/open';
import type { NewTopic } from '@/store/topics';
import { SessionRunner } from '@/cli/run-session';
import { KindTransport } from '@/orchestrator/transport.kind';
import { createOrchestrator, type Orchestrator } from '@/orchestrator/engine';
import { planFor } from '@/orchestrator/plan';
import { MAX_CONTRACT_PATCH_ROUNDS } from '@/orchestrator/contract-patch';
import { readTopicState } from '@/orchestrator/topic-state';

/**
 * WHY this path has its own file: the failure it is about was not a failure of the model.
 * A real prod run produced a lesson that was right except for one block whose "kind" was
 * not one of the kinds the contract lists — `blocks.12.kind:invalid_union_discriminator`.
 * Twelve good blocks were thrown away with the bad one, the subject went to
 * `needs-attention`, and the retry button re-ran the identical prompt. Nobody ever told
 * the session which field was wrong. These tests are about the telling.
 */
const intake: NewTopic = { subject: 'Knots', level: 'beginner', purpose: 'tie', diagnostic: null };

let dataRoot: string;
let store: Store;
let runner: SessionRunner;
let orchestrator: Orchestrator;
/** Every authoring prompt sent, in order, so the tests can read what the session was told. */
let authoringPrompts: string[];

const plan = planFor(intake);

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

/** The prod shape: a whole lesson, with one block whose kind is not in the contract. */
const badBlockContent = {
  ...goodContent,
  blocks: [
    { kind: 'prose', markdown: 'A bowline makes a loop that will not slip.' },
    { kind: 'diagram', svg: '<svg viewBox="0 0 1 1"></svg>', caption: 'The bowline' },
  ],
};

function outline(count: number): unknown {
  const nodes = Array.from({ length: count }, (_v, i) => ({ id: `n${i}`, title: `Lesson ${i + 1}` }));
  return {
    drivingQuestion: 'Why does this work?',
    modules: nodes,
    edges: nodes.slice(1).map((n) => ({ from: 'n0', to: n.id })),
  };
}

/** `authorBehaviour` is called once per authoring attempt, patch rounds included. */
function boot(authorBehaviour: (attempt: number, prompt: string) => unknown): void {
  let attempts = 0;
  authoringPrompts = [];
  runner = new SessionRunner({
    stallMs: 200,
    transport: new KindTransport({
      responder: (kind, prompt) => {
        if (kind === 'generate-topic') return outline(plan.estimatedModules);
        if (kind === 'capstone-spec') return { spec: 'Build it.' };
        if (kind === 'discontinuity-review') return { issues: [] };
        authoringPrompts.push(prompt);
        attempts += 1;
        return authorBehaviour(attempts - 1, prompt);
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

function refusalRounds(): string[] {
  return authoringPrompts.filter((p) => p.includes('YOUR PREVIOUS ANSWER WAS REFUSED'));
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-patch-'));
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

describe('F2 path: an authoring session misses the output contract', () => {
  it('tells the session which field was refused and keeps the lesson it then sends', async () => {
    // The first lesson has the bad block; every attempt after it is well-formed.
    boot((attempt) => (attempt === 0 ? badBlockContent : goodContent));
    const topic = store.topics.create(intake);
    await generate(topic);

    const modules = store.modules.graph(topic.id).nodes.filter((n) => n.kind === 'module');
    expect(modules.every((n) => n.content !== null)).toBe(true);
    expect(readTopicState(dataRoot, topic.id).status).toMatch(/^ready/);

    const patchPrompts = refusalRounds();
    expect(patchPrompts).toHaveLength(1);
    // The path, not a paraphrase: this is the whole information the round carries.
    expect(patchPrompts[0]).toContain('blocks.1.kind:invalid_union_discriminator');
    // It is still an authoring brief — the session that fixes the lesson can still see it.
    expect(patchPrompts[0]).toContain('OUTPUT CONTRACT');
    expect(patchPrompts[0]).toContain('Module title');
  });

  it('leaves a first-time-right lesson exactly as it was, with no extra session', async () => {
    boot(() => goodContent);
    const topic = store.topics.create(intake);
    await generate(topic);

    expect(refusalRounds()).toHaveLength(0);
    expect(authoringPrompts).toHaveLength(plan.estimatedModules);
  });

  it('gives up after its budget and fails the module the way it always did', async () => {
    boot(() => badBlockContent);
    const topic = store.topics.create(intake);
    await generate(topic);

    // One first attempt plus the correction rounds, for each module in the pass.
    expect(refusalRounds()).toHaveLength(MAX_CONTRACT_PATCH_ROUNDS * plan.estimatedModules);

    const state = readTopicState(dataRoot, topic.id);
    expect(state.status).toBe('needs-attention');
    const notes = state.notes.filter((n) => n.kind === 'generation-failure');
    expect(notes.length).toBeGreaterThan(0);
    // The learner is told about their lesson, not about the loop or its field paths.
    for (const note of notes) {
      expect(note.message).not.toContain('blocks.');
      expect(note.message).not.toContain('invalid_union_discriminator');
    }
    expect(store.modules.graph(topic.id).nodes.every((n) => n.kind !== 'module' || n.content === null)).toBe(true);
  });
});
