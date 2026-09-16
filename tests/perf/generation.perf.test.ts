// FRACTAL: covers F2 | type perf
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exampleModuleContent, type Topic } from '@/shapes';
import { resetConfigCache, saveConfig } from '@/core/config';
import { openStore, closeStore, type Store } from '@/store/open';
import type { NewTopic } from '@/store/topics';
import { SessionRunner } from '@/cli/run-session';
import { KindTransport } from '@/orchestrator/transport.kind';
import { createOrchestrator, type Orchestrator } from '@/orchestrator/engine';
import { planFor, prepPassesFor } from '@/orchestrator/plan';
import { unwrittenModules } from '@/orchestrator/prep-window';
import { readTopicState } from '@/orchestrator/topic-state';

// Declared scale: a full course for a broad subject — every module the plan names, one
// session per module plus research, the capstone spec and the single discontinuity review,
// written over as many prep passes as the lookahead takes.
const MODULES_PER_TOPIC = planFor({
  subject: 'Information theory coding compression channels',
  level: 'advanced',
  purpose: 'read Shannon carefully and build a practical compressor alongside an agent',
  diagnostic: null,
}).estimatedModules;
// WHY fewer samples than the twelve-module days: a course at declared scale is now about
// two and a half times as many modules and is written over several prep passes, so ten
// full courses is more work than the old twenty were.
const SAMPLES = 10;
const P95_BUDGET_MS = 20 * 60 * 1000;

const intake: NewTopic = {
  subject: 'Information theory coding compression channels',
  level: 'advanced',
  purpose: 'read Shannon carefully and build a practical compressor alongside an agent',
  diagnostic: null,
};

const plan = planFor(intake);
const goodContent = {
  ...exampleModuleContent,
  // WHY the body: a lesson with no "blocks" is queued for repair by C4/repair, and the
  // session count this measures is the count for a course that came back clean.
  blocks: [
    { kind: 'prose', markdown: 'The body of the test lesson.' },
    { kind: 'reveal', prompt: 'Work it out first.', answer: 'Like this.' },
  ],
  explanation: { kind: 'text', markdown: 'Lesson body.' },
};

let dataRoot: string;
let store: Store;
let runner: SessionRunner;
let orchestrator: Orchestrator;
let sessionsSpawned: number;

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function outline(count: number): unknown {
  const nodes = Array.from({ length: count }, (_v, i) => ({ id: `n${i}`, title: `Lesson ${i + 1}` }));
  return {
    drivingQuestion: 'How small can a message get?',
    modules: nodes,
    edges: nodes.slice(1).map((n) => ({ from: 'n0', to: n.id })),
  };
}

function boot(): void {
  sessionsSpawned = 0;
  runner = new SessionRunner({
    transport: new KindTransport({
      responder: (kind) => {
        sessionsSpawned += 1;
        if (kind === 'generate-topic') return outline(MODULES_PER_TOPIC);
        if (kind === 'capstone-spec') return { spec: 'Build it and defend every choice.' };
        if (kind === 'discontinuity-review') return { issues: [] };
        return goodContent;
      },
    }),
  });
  orchestrator = createOrchestrator({ store, runner, dataRoot });
}

function intakeFor(run: number): NewTopic {
  // WHY: each sample needs its own topic, and the subject is what the store
  // treats as unique. The suffix is short enough not to shift the estimate.
  return { ...intake, subject: `${intake.subject} ${run}` };
}

// WHY the loop: C4 prepares one lookahead of the prerequisite graph per authorised pass,
// so a course this size is written over several of them. The budget below covers the whole
// course, which is what the learner waits for.
async function generate(topic: Topic): Promise<void> {
  orchestrator.enqueueTopic(topic.id);
  await orchestrator.drain();
  for (let pass = 0; pass < prepPassesFor(MODULES_PER_TOPIC) + 1; pass += 1) {
    if (unwrittenModules(store.modules.graph(topic.id)).length === 0) break;
    orchestrator.resumeGeneration(topic.id);
    await orchestrator.drain();
  }
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-gen-perf-'));
  process.env.LA_DATA_ROOT = dataRoot;
  resetConfigCache();
  saveConfig({
    dataRoot,
    claudeBin: 'claude',
  });
  store = openStore(dataRoot);
  boot();
});

afterEach(async () => {
  await orchestrator.close();
  await runner.close();
  closeStore(dataRoot);
  delete process.env.LA_DATA_ROOT;
  resetConfigCache();
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('generation perf at declared scale', () => {
  it(`plans the declared scale: ${MODULES_PER_TOPIC} modules per topic`, () => {
    expect(plan.estimatedModules).toBe(MODULES_PER_TOPIC);
    expect(plan.sessionCount).toBe(MODULES_PER_TOPIC + 3);
    expect(plan.phases).toEqual(['research', 'authoring', 'capstone', 'review']);
  });

  it(
    `generates a full topic under the ${P95_BUDGET_MS}ms p95 budget over ${SAMPLES} samples`,
    async () => {
      const samples: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const runIntake = intakeFor(i);
        expect(planFor(runIntake).estimatedModules).toBe(MODULES_PER_TOPIC);
        const topic = store.topics.create(runIntake);
        const start = performance.now();
        await generate(topic);
        samples.push(performance.now() - start);

        const graph = store.modules.graph(topic.id);
        expect(graph.nodes.filter((n) => n.kind === 'module')).toHaveLength(MODULES_PER_TOPIC);
        expect(graph.nodes.every((n) => n.content !== null)).toBe(true);
        expect(readTopicState(dataRoot, topic.id).status).toMatch(/^ready/);
        expect(orchestrator.sessionsDispatchedFor(topic.id)).toBe(plan.sessionCount);
      }

      expect(samples).toHaveLength(SAMPLES);
      expect(sessionsSpawned).toBe(SAMPLES * plan.sessionCount);
      const sorted = [...samples].sort((a, b) => a - b);
      expect(percentile(sorted, 0.5)).toBeLessThan(P95_BUDGET_MS);
      expect(percentile(sorted, 0.95)).toBeLessThan(P95_BUDGET_MS);
      expect(Math.max(...samples)).toBeLessThan(P95_BUDGET_MS);
    },
    300000,
  );
});
