// FRACTAL: covers F2 | type integration
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
import { readInFlightIndex } from '@/orchestrator/reconcile';

/**
 * WHY this exists (F2 / swarm width): the pump used to drain jobs strictly one at a time —
 * `await runNext()` in a loop — so a second subject waited out the first subject's entire
 * course before its research session even started. In practice that was three `generate-topic`
 * jobs with one running and two queued for a quarter of an hour while permits went spare.
 * Jobs are independent of one another, and the provider load they add is bounded underneath
 * by C2's session limit, so they run beside each other.
 */
const KNOTS: NewTopic = { subject: 'Knots', level: 'beginner', purpose: 'tie', diagnostic: null };
const SAILING: NewTopic = { subject: 'Sailing', level: 'beginner', purpose: 'sail', diagnostic: null };

// WHY the plan's own count and not a number of our choosing: C4 pads an outline that comes
// back short up to the count the learner was quoted at intake, and a padded lesson is not
// attributable to a subject by title. Answering with exactly the planned count keeps every
// session in this test traceable to the topic that asked for it.
const PLANNED: Record<string, number> = {
  Knots: planFor(KNOTS).estimatedModules,
  Sailing: planFor(SAILING).estimatedModules,
};

let dataRoot: string;
let store: Store;
let runner: SessionRunner;
let orchestrator: Orchestrator;
/** Every session that ran, tagged with the subject its prompt was about. */
let seen: { kind: string; subject: string }[];

function subjectOf(prompt: string): string {
  return prompt.includes('Sailing') ? 'Sailing' : 'Knots';
}

function outlineFor(subject: string): unknown {
  // Titles carry the subject so an authoring session can be attributed to its topic.
  const modules = Array.from({ length: PLANNED[subject] }, (_v, i) => ({
    id: `n${i}`,
    title: `${subject} part ${i + 1}`,
    objectives: [`Explain ${subject} part ${i + 1}`],
  }));
  return {
    drivingQuestion: `What is really going on in ${subject}?`,
    modules,
    edges: modules.slice(1).map((m) => ({ from: modules[0].id, to: m.id })),
  };
}

function responder(kind: string, prompt: string): unknown {
  const subject = subjectOf(prompt);
  seen.push({ kind, subject });
  if (kind === 'generate-topic') return outlineFor(subject);
  if (kind === 'capstone-spec') return { spec: 'Build the thing and justify every choice.' };
  if (kind === 'discontinuity-review') return { issues: [] };
  return { ...exampleModuleContent, explanation: { kind: 'text', markdown: 'Written for the test.' } };
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-jobconc-'));
  process.env.LA_DATA_ROOT = dataRoot;
  resetConfigCache();
  saveConfig({ dataRoot, claudeBin: 'claude' });
  store = openStore(dataRoot);
  seen = [];
  // WHY a latency: with an instant reply a job can finish inside the same turn it started,
  // which would let a sequential drain look concurrent. This makes the overlap real.
  runner = new SessionRunner({ transport: new KindTransport({ responder, latencyMs: 5 }) });
  orchestrator = createOrchestrator({ store, runner, dataRoot });
});

afterEach(async () => {
  await orchestrator.close();
  await runner.close();
  closeStore();
  delete process.env.LA_DATA_ROOT;
  resetConfigCache();
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('the job pump', () => {
  it('researches two subjects beside each other rather than one after the other', async () => {
    const topics: Topic[] = [store.topics.create(KNOTS), store.topics.create(SAILING)];
    for (const topic of topics) orchestrator.enqueueTopic(topic.id);
    await orchestrator.drain();

    // Both outlines came back, and neither subject waited for the other's job to finish.
    expect(seen.filter((s) => s.kind === 'generate-topic').map((s) => s.subject).sort()).toEqual([
      'Knots',
      'Sailing',
    ]);
    for (const topic of topics) {
      expect(store.modules.graph(topic.id).nodes.filter((n) => n.kind === 'module')).toHaveLength(
        PLANNED[topic.subject],
      );
    }
  });

  /**
   * WHY the in-flight index and not the order sessions were spawned: a fan-out queues its
   * whole window in one synchronous burst, so spawn order shows the first subject's lessons
   * ahead of the second's whether the jobs overlap or not. The index is the engine's own
   * record of which jobs are open, written on every claim and every release, so two ids in
   * it is two jobs genuinely in the air at the same moment.
   */
  it('holds two subjects open at the same time instead of finishing one first', async () => {
    const topics: Topic[] = [store.topics.create(KNOTS), store.topics.create(SAILING)];
    for (const topic of topics) orchestrator.enqueueTopic(topic.id);
    await orchestrator.drain();
    for (const topic of topics) orchestrator.resumeGeneration(topic.id);

    let widest = 0;
    const draining = orchestrator.drain();
    // Sampled while the pump runs; `drain` is awaited below whatever this sees.
    for (let i = 0; i < 200 && widest < 2; i += 1) {
      widest = Math.max(widest, readInFlightIndex(dataRoot).length);
      await new Promise((r) => setTimeout(r, 1));
    }
    await draining;

    expect(widest).toBe(2);
    for (const topic of topics) {
      const written = store.modules
        .graph(topic.id)
        .nodes.filter((n) => n.kind === 'module' && n.content !== null);
      expect(written).toHaveLength(PLANNED[topic.subject]);
    }
  });
});
