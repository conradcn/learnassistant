// FRACTAL: covers F2 | type integration | path module-session-fails
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exampleModuleContent, isoDateStringSchema, type Topic } from '@/shapes';
import { resetConfigCache, saveConfig } from '@/core/config';
import { openStore, closeStore, type Store } from '@/store/open';
import type { NewTopic } from '@/store/topics';
import { SessionRunner } from '@/cli/run-session';
import { KindTransport } from '@/orchestrator/transport.kind';
import { createOrchestrator, type Orchestrator } from '@/orchestrator/engine';
import { planFor } from '@/orchestrator/plan';
import { prepWindow } from '@/orchestrator/prep-window';
import { MAX_REPAIR_ROUNDS, REPAIR_TARGETS_PER_ROUND } from '@/orchestrator/repair.budget';
import { REVIEW_UNAVAILABLE_NOTE } from '@/orchestrator/discontinuity';
import { addTopicNotes, readTopicState } from '@/orchestrator/topic-state';

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

let dataRoot: string;
let store: Store;
let runner: SessionRunner;
let orchestrator: Orchestrator;

const plan = planFor(intake);

function outline(count: number): unknown {
  const nodes = Array.from({ length: count }, (_v, i) => ({ id: `n${i}`, title: `Lesson ${i + 1}` }));
  return { drivingQuestion: 'Why does this work?', modules: nodes, edges: nodes.slice(1).map((n) => ({ from: 'n0', to: n.id })) };
}

function boot(authorBehaviour: (index: number) => unknown | 'fail' | 'hang'): void {
  let authored = 0;
  runner = new SessionRunner({
    stallMs: 200,
    transport: new KindTransport({
      responder: (kind) => {
        if (kind === 'generate-topic') return outline(plan.estimatedModules);
        if (kind === 'capstone-spec') return { spec: 'Build it.' };
        if (kind === 'discontinuity-review') return { issues: [] };
        authored += 1;
        return authorBehaviour(authored - 1);
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

const goodContent = { ...exampleModuleContent, explanation: { kind: 'text', markdown: 'Real lesson.' } };

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-fail-'));
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

describe('F2 path: one authoring session fails', () => {
  it('keeps every other module, marks the topic needs-attention, and names the failed one', async () => {
    boot((i) => (i === 2 ? 'fail' : goodContent));
    const topic = store.topics.create(intake);
    await generate(topic);

    const graph = store.modules.graph(topic.id);
    const modules = graph.nodes.filter((n) => n.kind === 'module');
    const authored = modules.filter((n) => n.content !== null);
    expect(authored).toHaveLength(plan.estimatedModules - 1);
    expect(modules.filter((n) => n.content === null)).toHaveLength(1);

    const state = readTopicState(dataRoot, topic.id);
    expect(state.status).toBe('needs-attention');
    const failureNote = state.notes.find((n) => n.kind === 'generation-failure');
    expect(failureNote?.message).toMatch(/^Authoring failed for "/);
    expect(failureNote?.affectedModules).toHaveLength(1);
    // The learner never sees a raw code, a path or a stack trace.
    expect(failureNote?.message).not.toMatch(/[A-Za-z]:\\|\/tmp\/|at Object\./);
  });

  it('offers a retry for exactly that module, and the retry completes it', async () => {
    boot((i) => (i === 2 ? 'fail' : goodContent));
    const topic = store.topics.create(intake);
    await generate(topic);

    const failed = store.modules.graph(topic.id).nodes.find((n) => n.kind === 'module' && n.content === null);
    expect(failed).toBeDefined();
    if (!failed) throw new Error('expected one failed module');
    orchestrator.retryModule(topic.id, failed.id);
    await orchestrator.drain();

    const after = store.modules.graph(topic.id).nodes.find((n) => n.id === failed.id);
    expect(after?.content).not.toBeNull();
    expect(readTopicState(dataRoot, topic.id).status).toMatch(/^ready/);
  });

  it('times out a stalled session rather than hanging, and treats it as a module failure', async () => {
    boot((i) => (i === 0 ? 'hang' : goodContent));
    const topic = store.topics.create(intake);
    await generate(topic);

    const state = readTopicState(dataRoot, topic.id);
    expect(state.status).toBe('needs-attention');
    expect(state.notes.some((n) => n.kind === 'generation-failure')).toBe(true);
    const stillGood = store.modules.graph(topic.id).nodes.filter((n) => n.kind === 'module' && n.content !== null);
    expect(stillGood.length).toBe(plan.estimatedModules - 1);
  });
});

/**
 * WHY this whole block: on the real run behind it, a first pass lost most of the lessons
 * and a second pass wrote them. Every lesson was then on disk and readable — and the
 * subject page still carried "Authoring failed" for each one, "The project brief could not
 * be written" beside the brief that had just been written, and an offer to re-run a
 * consistency check that could no longer be re-run. Nothing was broken except the account
 * the plan gave of itself, which is the only thing the learner can see.
 */
describe('F2 path: a second pass writes what the first pass lost', () => {
  /** Fails the first pass over the lessons, then answers properly on the pass after it. */
  function bootFlakyFirstPass(): void {
    let pass = 0;
    boot(() => {
      pass += 1;
      return pass <= plan.estimatedModules ? 'fail' : goodContent;
    });
  }

  async function rerun(topic: Topic): Promise<void> {
    orchestrator.resumeGeneration(topic.id);
    await orchestrator.drain();
  }

  it('takes down the failure notes for the lessons it has just written', async () => {
    bootFlakyFirstPass();
    const topic = store.topics.create(intake);
    await generate(topic);
    expect(readTopicState(dataRoot, topic.id).notes.some((n) => n.kind === 'generation-failure')).toBe(true);

    await rerun(topic);

    const graph = store.modules.graph(topic.id);
    expect(graph.nodes.every((n) => n.content !== null)).toBe(true);
    const state = readTopicState(dataRoot, topic.id);
    expect(state.notes.filter((n) => n.kind === 'generation-failure')).toEqual([]);
    expect(state.status).toMatch(/^ready/);
  });

  // WHY: the check answers "do these lessons fit together". Ten of them are new, so the
  // answer recorded for the old set does not describe what is on disk any more.
  it('checks how the lessons fit together again, now that they are different lessons', async () => {
    bootFlakyFirstPass();
    const topic = store.topics.create(intake);
    await generate(topic);

    await rerun(topic);

    expect(readTopicState(dataRoot, topic.id).reviewRuns).toBe(1);
    expect(store.modules.graph(topic.id).nodes.every((n) => n.content !== null)).toBe(true);
  });

  /**
   * WHY: the first check ran over a curriculum that was missing most of its lessons, so its
   * findings are about a plan that no longer exists. On the real run this left the learner
   * holding both rounds at once — including a finding objecting that the project brief was
   * "Not written yet" printed beside the brief that had just been written.
   */
  it('keeps both rounds of check findings off the page entirely', async () => {
    const STALE = 'Lesson 7 is missing, so the arc does not close.';
    const FRESH = 'Lesson 7 now repeats material that lesson 3 already covers.';
    let reviews = 0;
    let pass = 0;
    runner = new SessionRunner({
      stallMs: 200,
      transport: new KindTransport({
        responder: (kind) => {
          if (kind === 'generate-topic') return outline(plan.estimatedModules);
          if (kind === 'capstone-spec') return { spec: 'Build it.' };
          if (kind === 'discontinuity-review') {
            reviews += 1;
            return { issues: [{ message: reviews === 1 ? STALE : FRESH }] };
          }
          // The first pass writes most of the lessons and loses the last three, so the
          // check has something to run over; the second pass completes them.
          pass += 1;
          return pass > plan.estimatedModules - 3 && pass <= plan.estimatedModules ? 'fail' : goodContent;
        },
      }),
    });
    orchestrator = createOrchestrator({ store, runner, dataRoot });

    const topic = store.topics.create(intake);
    await generate(topic);
    expect(readTopicState(dataRoot, topic.id).notes.map((n) => n.message)).not.toContain(STALE);

    await rerun(topic);

    // A finding is a work list for the writer, so neither round of them is a thing the
    // learner is ever handed — not the stale one, and not the one that replaced it.
    const messages = readTopicState(dataRoot, topic.id).notes.map((n) => n.message);
    expect(messages).not.toContain(FRESH);
    expect(messages).not.toContain(STALE);
    expect(reviews).toBeGreaterThan(1);
  });

  /**
   * WHY it is worth counting: a resume that dispatches more sessions than the remaining
   * work needs is not overrunning quietly — it is rewriting things that are already
   * finished, which is how a resume came to spend a session on a completed project brief.
   */
  it('spends no more sessions on a resume than the work left over needs', async () => {
    bootFlakyFirstPass();
    const topic = store.topics.create(intake);
    await generate(topic);
    const graph = store.modules.graph(topic.id);
    // What this pass has left to do: the lessons in the window, the project brief if it is
    // still unwritten, the consistency check, and the repair loop's own ceiling.
    const covered =
      prepWindow(graph).length +
      graph.nodes.filter((n) => n.kind === 'capstone' && n.content === null).length +
      1 +
      MAX_REPAIR_ROUNDS * (REPAIR_TARGETS_PER_ROUND + 1);
    let dispatched = 0;
    const countingRunner = runner.run.bind(runner);
    runner.run = ((...args: Parameters<SessionRunner['run']>) => {
      dispatched += 1;
      return countingRunner(...args);
    }) as SessionRunner['run'];

    await rerun(topic);

    // WHY no longer an equality: the plan now carries the repair loop's ceiling, and a
    // ceiling is spent only as far as the check asks for. Under is right; over is the bug.
    expect(dispatched).toBeGreaterThan(0);
    expect(dispatched).toBeLessThanOrEqual(covered);
    // and the check the learner paid for is among what ran, not the session that got squeezed out
    expect(readTopicState(dataRoot, topic.id).notes.map((n) => n.message)).not.toContain(REVIEW_UNAVAILABLE_NOTE);
  });

  // WHY: the research note is not about a lesson and this pass did not re-research, so it
  // is still true. Clearing every failure note at the top of the writing pass took it with
  // the rest and left the learner with no sign their plan was a generic fallback.
  it('leaves a note standing that describes work it is not redoing', async () => {
    boot(() => goodContent);
    const topic = store.topics.create(intake);
    const outlineNote = {
      kind: 'generation-failure' as const,
      message: 'Could not research an outline, so this was split up by subtopic instead.',
      affectedModules: [],
      createdAt: isoDateStringSchema.parse(new Date().toISOString()),
    };
    await generate(topic);
    addTopicNotes(dataRoot, topic.id, [outlineNote]);

    await rerun(topic);

    const state = readTopicState(dataRoot, topic.id);
    expect(state.notes.map((n) => n.message)).toContain(outlineNote.message);
  });
});

describe('F2 path: every authoring session fails', () => {
  it('names the shared cause exactly once and presents nothing partial as complete', async () => {
    boot(() => 'fail');
    const topic = store.topics.create(intake);
    await generate(topic);

    const state = readTopicState(dataRoot, topic.id);
    expect(state.status).toBe('needs-attention');
    const shared = state.notes.filter((n) => n.kind === 'generation-failure' && n.affectedModules.length === 0);
    expect(shared).toHaveLength(1);
    expect(shared[0].message).toMatch(/None of the lessons could be written/);
    expect(shared[0].message).toMatch(/Retry topic/);

    expect(store.modules.graph(topic.id).nodes.every((n) => n.content === null)).toBe(true);
    // Neither the capstone spec nor the review runs over an empty curriculum.
    expect(readTopicState(dataRoot, topic.id).reviewRuns).toBe(0);
  });
});

