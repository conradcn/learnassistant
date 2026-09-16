// FRACTAL: covers F2 | type integration | path queue-recovery-after-restart
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exampleTopicIntakeRequest } from '@/shapes';
import { resetConfigCache, saveConfig } from '@/core/config';
import { openStore, closeStore, type Store } from '@/store/open';
import type { NewTopic } from '@/store/topics';
import { SessionRunner } from '@/cli/run-session';
import { KindTransport } from '@/orchestrator/transport.kind';
import { createOrchestrator, type Orchestrator } from '@/orchestrator/engine';
import { readTopicState, setTopicStatus } from '@/orchestrator/topic-state';

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

function boot(): void {
  runner = new SessionRunner({
    stallMs: 200,
    transport: new KindTransport({
      responder: () => ({ drivingQuestion: 'Why?', modules: [{ id: 'n0', title: 'One' }], edges: [] }),
    }),
  });
  orchestrator = createOrchestrator({ store, runner, dataRoot });
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-drain-'));
  process.env.LA_DATA_ROOT = dataRoot;
  resetConfigCache();
  saveConfig({ dataRoot, claudeBin: 'claude' });
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

describe('F2 path: the queue drains after a restart', () => {
  it('requeues a job left running even when the in-flight index never recorded it', () => {
    const topic = store.topics.create(intake);
    orchestrator.enqueueTopic(topic.id);
    // The claim is what a dying process leaves behind; the index write is what it never got to.
    const claimed = store.jobs.claimNext();
    expect(claimed?.status).toBe('running');
    writeFileSync(path.join(dataRoot, 'in-flight-jobs.json'), '[]', 'utf8');

    orchestrator.resetRunningJobsAtBoot();

    expect(store.jobs.claimNext()?.id).toBe(claimed?.id);
  });

  it('shuts down cleanly when the data root can no longer be written', async () => {
    // A full or read-only disk at exit: clearing the in-flight index fails. The index is
    // only a hint — boot recovery requeues from the jobs table — so a shutdown must not
    // turn that failure into an unhandled rejection.
    const stuck = mkdtempSync(path.join(os.tmpdir(), 'la-stuck-'));
    mkdirSync(path.join(stuck, 'in-flight-jobs.json.tmp'), { recursive: true });
    const doomed = createOrchestrator({ store, runner, dataRoot: stuck });

    await expect(doomed.close()).resolves.toBeUndefined();

    rmSync(stuck, { recursive: true, force: true });
  });

  it('hands back a subject that is waiting on a job nobody has, instead of leaving the spinner up', async () => {
    const topic = store.topics.create(intake);
    orchestrator.enqueueTopic(topic.id);
    expect(readTopicState(dataRoot, topic.id).status).toBe('queued');

    // A fresh process: the sidecar still says the subject is being planned, but the job
    // that was planning it went down with the process that claimed it.
    const claimed = store.jobs.claimNext();
    store.jobs.finish(String(claimed?.id), 'cancelled');
    expect(store.jobs.pendingFor(topic.id)).toBe(0);

    const restarted = createOrchestrator({ store, runner, dataRoot });
    restarted.resetRunningJobsAtBoot();
    await restarted.close();

    const state = readTopicState(dataRoot, topic.id);
    expect(state.status).toBe('needs-attention');
    expect(state.notes.some((n) => n.message.includes('Plan the lessons'))).toBe(true);
  });

  it('leaves a subject alone when its job is still queued', () => {
    const topic = store.topics.create(intake);
    orchestrator.enqueueTopic(topic.id);
    setTopicStatus(dataRoot, topic.id, 'queued');

    orchestrator.resetRunningJobsAtBoot();

    expect(readTopicState(dataRoot, topic.id).status).toBe('queued');
  });
});
