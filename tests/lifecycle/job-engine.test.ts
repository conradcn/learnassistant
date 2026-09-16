// FRACTAL: covers F1, F2 | type integration
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  exampleModuleContent,
  exampleTopicIntakeRequest,
  generationProgressSchema,
  jobSchema,
  type GenerationProgress,
  type Job,
} from '@/shapes';
import { resetConfigCache, saveConfig } from '@/core/config';
import { openStore, closeStore, type Store } from '@/store/open';
import type { NewTopic } from '@/store/topics';
import { SessionRunner } from '@/cli/run-session';
import { KindTransport } from '@/orchestrator/transport.kind';
import { createOrchestrator, type Orchestrator } from '@/orchestrator/engine';
import { newJobId } from '@/orchestrator/ids';
import { planFor } from '@/orchestrator/plan';
import { readInFlightIndex, writeInFlightIndex } from '@/orchestrator/reconcile';
import { readTopicState, setTopicStatus } from '@/orchestrator/topic-state';

const intake: NewTopic = {
  subject: exampleTopicIntakeRequest.subject,
  level: exampleTopicIntakeRequest.level,
  purpose: exampleTopicIntakeRequest.purpose,
  diagnostic: null,
};

const plan = planFor(intake);
const goodContent = { ...exampleModuleContent, explanation: { kind: 'text', markdown: 'Real lesson.' } };

let dataRoot: string;
let store: Store;
let runner: SessionRunner;
let orchestrator: Orchestrator;

function outline(count: number): unknown {
  const nodes = Array.from({ length: count }, (_v, i) => ({ id: `n${i}`, title: `Lesson ${i + 1}` }));
  return {
    drivingQuestion: 'Why does this work?',
    modules: nodes,
    edges: nodes.slice(1).map((n) => ({ from: 'n0', to: n.id })),
  };
}

function boot(latencyMs: number): void {
  runner = new SessionRunner({
    stallMs: 5000,
    transport: new KindTransport({
      latencyMs,
      responder: (kind) => {
        if (kind === 'generate-topic') return outline(plan.estimatedModules);
        if (kind === 'capstone-spec') return { spec: 'Build it.' };
        if (kind === 'discontinuity-review') return { issues: [] };
        return goodContent;
      },
    }),
  });
  orchestrator = createOrchestrator({ store, runner, dataRoot });
}

function queueGeneration(): { job: Job; topicId: Job['topicId'] } {
  const topic = store.topics.create(intake);
  const job = orchestrator.enqueueTopic(topic.id);
  return { job, topicId: topic.id };
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-job-'));
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

describe('the job engine owns every task it starts', () => {
  it('records the in-flight job durably while it runs and clears it on every exit path', async () => {
    boot(0);
    const { job, topicId } = queueGeneration();
    expect(() => jobSchema.parse(job)).not.toThrow();

    const running = orchestrator.runNext();
    expect(readInFlightIndex(dataRoot)).toContain(job.id);
    const finished = await running;
    expect(finished?.status).toBe('succeeded');
    expect(readInFlightIndex(dataRoot)).toEqual([]);
    expect(store.modules.graph(topicId).nodes.length).toBeGreaterThan(0);
  });

  it('emits progress to every subscriber and stops emitting once the subscriber leaves', async () => {
    boot(0);
    const { topicId } = queueGeneration();
    const seen: GenerationProgress[] = [];
    const iterator = orchestrator.subscribe(topicId)[Symbol.asyncIterator]();
    const first = iterator.next();
    await orchestrator.runNext();
    const tick = await first;
    if (tick.done) throw new Error('expected at least one progress tick');
    seen.push(tick.value);

    expect(() => generationProgressSchema.parse(seen[0])).not.toThrow();
    expect(seen[0].topicId).toBe(topicId);
    expect(seen[0].phase).toBe('research');
    expect(seen[0].lastTickAt.length).toBeGreaterThan(0);

    const closed = await iterator.return?.();
    expect(closed?.done).toBe(true);
    expect(orchestrator.progress(topicId).modulesTotal).toBeGreaterThan(0);
  });

  it('cancels the work in flight when the owner is torn down', async () => {
    boot(400);
    const { job } = queueGeneration();
    const running = orchestrator.runNext();
    await Promise.resolve();
    await orchestrator.close();
    const finished = await running;

    expect(finished?.id).toBe(job.id);
    expect(['cancelled', 'failed']).toContain(finished?.status);
    expect(readInFlightIndex(dataRoot)).toEqual([]);
    expect(await orchestrator.runNext()).toBeNull();
  });

  it('cancels a named job on request without touching the others', async () => {
    boot(400);
    const { job } = queueGeneration();
    const running = orchestrator.runNext();
    await Promise.resolve();
    orchestrator.cancel(job.id);
    const finished = await running;
    expect(finished?.status).toBe('cancelled');
    expect(readInFlightIndex(dataRoot)).toEqual([]);
  });
});

describe('a process that died mid-generation', () => {
  it('resets jobs left running back to queued, preserving their attempt count', async () => {
    boot(0);
    const { job } = queueGeneration();
    const claimed = store.jobs.claimNext();
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe('running');
    expect(claimed?.attempts).toBe(1);
    writeInFlightIndex(dataRoot, [job.id]);

    const rebooted = createOrchestrator({ store, runner, dataRoot });
    expect(rebooted.resetRunningJobsAtBoot()).toEqual([job.id]);
    expect(readInFlightIndex(dataRoot)).toEqual([]);

    const reclaimed = store.jobs.claimNext();
    expect(reclaimed?.id).toBe(job.id);
    expect(reclaimed?.attempts).toBe(2);
    await rebooted.close();
  });

  it('shows a topic that was generating as queued again, so the learner sees it resuming', async () => {
    boot(0);
    const { topicId } = queueGeneration();
    setTopicStatus(dataRoot, topicId, 'generating');

    const rebooted = createOrchestrator({ store, runner, dataRoot });
    rebooted.resetRunningJobsAtBoot();
    expect(readTopicState(dataRoot, topicId).status).toBe('queued');
    expect(rebooted.progress(topicId).phase).toBe('research');
    await rebooted.close();
  });

  it('ignores an in-flight index naming a job the store never had', async () => {
    boot(0);
    writeInFlightIndex(dataRoot, [newJobId(), 'not-a-job-id']);
    const rebooted = createOrchestrator({ store, runner, dataRoot });
    expect(rebooted.resetRunningJobsAtBoot()).toEqual([]);
    expect(readInFlightIndex(dataRoot)).toEqual([]);
    await rebooted.close();
  });
});
