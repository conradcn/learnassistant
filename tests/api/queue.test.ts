// FRACTAL: covers F1, F5 | type integration | path queue-view
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exampleAppError, moduleIdSchema, type Job, type ModuleGraph, type Topic } from '@/shapes';
import { resetConfigCache, saveConfig } from '@/core/config';
import { openStore, closeStore, type Store } from '@/store/open';
import type { Services } from '@/api/services';
import { QUEUE_LIMIT, queueView } from '@/api/queue';

let dataRoot: string;
let store: Store;
let topic: Topic;

/** The view only ever reads the store, so this is the whole of the container it needs. */
function services(): Services {
  return { store, dataRoot } as unknown as Services;
}

function moduleId(n: number): ModuleGraph['nodes'][number]['id'] {
  return moduleIdSchema.parse(`m_${String(n).padStart(16, '0')}`);
}

function job(over: Partial<Job> & Pick<Job, 'id' | 'kind' | 'status'>): Job {
  return {
    topicId: topic.id,
    moduleId: null,
    attempts: 1,
    startedAt: null,
    finishedAt: null,
    error: null,
    ...over,
  } as Job;
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-queue-'));
  process.env.LA_DATA_ROOT = dataRoot;
  resetConfigCache();
  saveConfig({ dataRoot, claudeBin: 'claude' });
  store = openStore(dataRoot);
  topic = store.topics.create({ subject: 'Information theory', level: 'beginner', purpose: 'read papers', diagnostic: null });
  store.modules.upsertGraph({
    topicId: topic.id,
    nodes: [
      {
        id: moduleId(1),
        topicId: topic.id,
        title: 'Entropy as expected surprise',
        ordinal: 1,
        kind: 'module',
        testOutEligible: false,
        estimatedMinutes: 20,
        state: 'available',
        content: null,
      },
    ],
    edges: [],
    entryModules: [moduleId(1)],
  });
});

afterEach(() => {
  closeStore(dataRoot);
  delete process.env.LA_DATA_ROOT;
  resetConfigCache();
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('the queue view', () => {
  it('says nothing is happening when nothing has been asked for', () => {
    const view = queueView(services());
    expect(view).toEqual({ waiting: 0, running: 0, entries: [] });
  });

  it('names the subject and the lesson each piece of work is for', () => {
    store.jobs.enqueue(job({ id: 'j_topic', kind: 'generate-topic', status: 'queued' }));
    store.jobs.enqueue(job({ id: 'j_mod', kind: 'author-module', status: 'queued', moduleId: moduleId(1) }));

    const view = queueView(services());
    const byId = new Map(view.entries.map((e) => [e.id, e]));
    expect(byId.get('j_topic')?.subject).toBe('Information theory');
    expect(byId.get('j_topic')?.lessonTitle).toBeNull();
    expect(byId.get('j_mod')?.lessonTitle).toBe('Entropy as expected surprise');
  });

  it('tells a pass that will plan the outline apart from one that will write into it', () => {
    store.jobs.enqueue(job({ id: 'j_write', kind: 'generate-topic', status: 'queued' }));
    // The subject already has its outline (the fixture upserts one), so the pass this
    // entry describes is the writing half, not the research half.
    expect(queueView(services()).entries.find((e) => e.id === 'j_write')?.plansOutline).toBe(false);

    // A subject with nothing planned yet: the same job kind, the other half of the work.
    const fresh = store.topics.create({ subject: 'Optics', level: 'beginner', purpose: 'curiosity', diagnostic: null });
    store.jobs.enqueue(job({ id: 'j_plan', kind: 'generate-topic', status: 'queued', topicId: fresh.id }));
    expect(queueView(services()).entries.find((e) => e.id === 'j_plan')?.plansOutline).toBe(true);

    // A lesson-sized job is never the outline, whatever the subject looks like.
    store.jobs.enqueue(job({ id: 'j_one', kind: 'author-module', status: 'queued', moduleId: moduleId(1) }));
    expect(queueView(services()).entries.find((e) => e.id === 'j_one')?.plansOutline).toBe(false);
  });

  it('counts what is waiting and what is running', () => {
    store.jobs.enqueue(job({ id: 'j_a', kind: 'author-module', status: 'queued' }));
    store.jobs.enqueue(job({ id: 'j_b', kind: 'author-module', status: 'queued' }));
    store.jobs.claimNext();

    const view = queueView(services());
    expect(view).toMatchObject({ waiting: 1, running: 1 });
  });

  // WHY this ordering is asserted: the rows someone opens this screen for are the ones
  // still to happen. Buried under this morning's successes, the screen fails at its one job.
  it('puts unfinished work first, oldest first, and finished work after it', () => {
    store.jobs.enqueue(job({ id: 'j_old_done', kind: 'author-module', status: 'queued' }));
    store.jobs.claimNext();
    store.jobs.finish('j_old_done', 'succeeded');
    store.jobs.enqueue(job({ id: 'j_first_waiting', kind: 'author-module', status: 'queued' }));
    store.jobs.enqueue(job({ id: 'j_second_waiting', kind: 'author-module', status: 'queued' }));

    const view = queueView(services());
    expect(view.entries.map((e) => e.id)).toEqual(['j_first_waiting', 'j_second_waiting', 'j_old_done']);
  });

  it('carries the sentence from a failure and never its code or correlation id', () => {
    store.jobs.enqueue(job({ id: 'j_failed', kind: 'author-module', status: 'queued' }));
    store.jobs.claimNext();
    store.jobs.finish('j_failed', 'failed', exampleAppError);

    const entry = queueView(services()).entries.find((e) => e.id === 'j_failed');
    expect(entry?.errorMessage).toBe(exampleAppError.message);
    expect(JSON.stringify(entry)).not.toContain(exampleAppError.correlationId);
    expect(JSON.stringify(entry)).not.toContain('"code"');
  });

  it('caps the list but still counts every waiting piece of work', () => {
    for (let i = 0; i < QUEUE_LIMIT + 5; i += 1) {
      store.jobs.enqueue(job({ id: `j_${i}`, kind: 'author-module', status: 'queued' }));
    }

    const view = queueView(services());
    expect(view.entries).toHaveLength(QUEUE_LIMIT);
    // WHY: a summary that said "20 waiting" because 20 is all that fits would be wrong in
    // exactly the situation the reader most needs it to be right.
    expect(view.waiting).toBe(QUEUE_LIMIT + 5);
  });
});
