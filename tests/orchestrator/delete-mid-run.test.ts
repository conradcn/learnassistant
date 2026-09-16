// FRACTAL: covers F1, F2 | type integration | path delete-subject-mid-generation
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exampleModuleContent, type TopicId } from '@/shapes';
import { resetConfigCache, saveConfig } from '@/core/config';
import { openStore, closeStore, type Store } from '@/store/open';
import type { NewTopic } from '@/store/topics';
import { SessionRunner } from '@/cli/run-session';
import { KindTransport } from '@/orchestrator/transport.kind';
import { createOrchestrator, type Orchestrator } from '@/orchestrator/engine';
import { planFor } from '@/orchestrator/plan';
import { deleteTopicEverywhere } from '@/orchestrator/delete-topic';

const intake: NewTopic = {
  subject: 'Knots',
  level: 'beginner',
  purpose: 'tie',
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

/** Every log line this run wrote, so the test can ask what was reported. */
function logLines(): Record<string, unknown>[] {
  const dir = path.join(dataRoot, 'logs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((f) => readFileSync(path.join(dir, f), 'utf8').split('\n'))
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function topicDirExists(topicId: TopicId): boolean {
  return existsSync(path.join(dataRoot, 'topics', topicId));
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-del-'));
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

/**
 * WHY this exists: deleting a subject while its lessons were being written used to leave
 * the run going. The next commit wrote content.json and then failed the foreign key on
 * `module_nodes.topic_id`, which was reported as an `internal` fault, which wrote a
 * "needs-attention" sidecar — recreating the deleted subject's directory. Nothing walks a
 * subject without a row, so that directory was there forever and the learner could not see
 * or remove it. A second copy arrived later from whatever was still queued.
 */
describe('F1 path: the learner deletes a subject while it is being written', () => {
  it('stops the run, leaves nothing on disk, leaves no claimable job and reports no fault', async () => {
    let topicId: TopicId | null = null;
    let authored = 0;
    runner = new SessionRunner({
      stallMs: 200,
      transport: new KindTransport({
        responder: (kind) => {
          if (kind === 'generate-topic') return outline(plan.estimatedModules);
          if (kind === 'capstone-spec') return { spec: 'Build it.' };
          if (kind === 'discontinuity-review') return { issues: [] };
          authored += 1;
          // The delete lands in the middle of an authoring session, exactly as it does
          // when the learner presses the button while the spinner is up.
          if (authored === 1 && topicId !== null) {
            deleteTopicEverywhere({ store, dataRoot, orchestrator }, topicId);
          }
          return goodContent;
        },
      }),
    });
    orchestrator = createOrchestrator({ store, runner, dataRoot });

    const topic = store.topics.create(intake);
    topicId = topic.id;
    orchestrator.enqueueTopic(topic.id);
    await orchestrator.drain();
    expect(topicDirExists(topic.id)).toBe(true);

    orchestrator.resumeGeneration(topic.id);
    await orchestrator.drain();

    // (a) nothing of the deleted subject is left on disk.
    expect(topicDirExists(topic.id)).toBe(false);

    // (b) nothing is left for the queue to hand out, now or on the next boot.
    expect(store.jobs.pendingFor(topic.id)).toBe(0);
    expect(await orchestrator.drain()).toEqual([]);
    expect(orchestrator.resetRunningJobsAtBoot()).toEqual([]);
    expect(topicDirExists(topic.id)).toBe(false);

    // (c) a deletion the learner asked for is not a fault.
    const internal = logLines().filter((l) => l.code === 'internal');
    expect(internal).toEqual([]);
    expect(logLines().some((l) => l.event === 'orchestrator-job-topic-deleted')).toBe(true);

    // And the subject really is gone, rather than half-gone.
    expect(store.topics.get(topic.id)).toBeNull();
    expect(store.modules.graph(topic.id).nodes).toEqual([]);
  });
});
