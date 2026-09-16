// FRACTAL: covers F2 | type unit
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exampleTopicIntakeRequest, topicIdSchema } from '@/shapes';
import { resetConfigCache, saveConfig } from '@/core/config';
import { openStore, closeStore, type Store } from '@/store/open';
import type { NewTopic } from '@/store/topics';
import { SessionRunner } from '@/cli/run-session';
import { KindTransport } from '@/orchestrator/transport.kind';
import { createOrchestrator, type Orchestrator } from '@/orchestrator/engine';
import {
  authoringPhaseSessionCount,
  estimateModules,
  generationPlanSchema,
  planFor,
  sessionCountFor,
  prepPassesFor,
  MIN_MODULES,
} from '@/orchestrator/plan';
import { MAX_PREP_MODULES } from '@/orchestrator/prep-window';

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

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-plan-'));
  process.env.LA_DATA_ROOT = dataRoot;
  resetConfigCache();
  saveConfig({ dataRoot, claudeBin: 'claude' });
  store = openStore(dataRoot);
  runner = new SessionRunner({ transport: new KindTransport({ responder: () => ({}) }) });
  orchestrator = createOrchestrator({ store, runner, dataRoot });
});

afterEach(async () => {
  await orchestrator.close();
  await runner.close();
  closeStore(dataRoot);
  delete process.env.LA_DATA_ROOT;
  resetConfigCache();
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('planFor', () => {
  it('produces a plan that validates against its shape', () => {
    expect(() => generationPlanSchema.parse(planFor(intake))).not.toThrow();
    expect(planFor(intake).phases).toEqual(['research', 'authoring', 'capstone', 'review']);
  });

  it('is deterministic: the same intake always yields the same counts', () => {
    const first = planFor(intake);
    for (let i = 0; i < 25; i += 1) {
      expect(planFor(intake)).toEqual(first);
    }
  });

  it('has a floor but no ceiling: a degree-sized ask plans a degree-sized course', () => {
    expect(estimateModules({ ...intake, subject: 'Go', purpose: '', level: 'beginner' })).toBe(MIN_MODULES);
    // WHY no upper clamp: capping the count never made the ask smaller, it made each
    // lesson wider. What is bounded is how much is prepared at once, not the plan.
    expect(
      estimateModules({
        ...intake,
        subject: 'Advanced measure theoretic probability and stochastic calculus foundations',
        purpose: 'derive pricing models properly rather than memorise formulas quickly',
        level: 'advanced',
      }),
    ).toBeGreaterThan(24);
  });

  it('splits the session count into exactly research + authoring-phase', () => {
    const plan = planFor(intake);
    expect(plan.sessionCount).toBe(sessionCountFor(plan.estimatedModules));
    expect(plan.sessionCount).toBe(1 + authoringPhaseSessionCount(plan.estimatedModules));
    // Every module, the capstone spec, and the one consistency check.
    expect(authoringPhaseSessionCount(plan.estimatedModules)).toBe(plan.estimatedModules + 2);
  });

  // WHY: the prep window spreads a long course over several authorisations, and it would
  // be a bug for that to cost the learner more sessions than the course itself needs.
  it('spreads a long course over passes without charging for the extra passes', () => {
    expect(prepPassesFor(MAX_PREP_MODULES)).toBe(1);
    expect(prepPassesFor(MAX_PREP_MODULES * 3)).toBe(3);
    expect(authoringPhaseSessionCount(MAX_PREP_MODULES * 3)).toBe(MAX_PREP_MODULES * 3 + 2);
    expect(sessionCountFor(MAX_PREP_MODULES * 3)).toBe(MAX_PREP_MODULES * 3 + 3);
  });

  it('drops a module for each thing the diagnostic showed the learner already knows', () => {
    const midSized: NewTopic = { ...intake, subject: 'Graphs', purpose: 'plan trips', level: 'beginner' };
    expect(estimateModules(midSized)).toBeGreaterThan(MIN_MODULES);

    const withDiagnostic: NewTopic = {
      ...midSized,
      diagnostic: {
        skipped: false,
        exchanges: [],
        priorKnowledge: ['probability', 'logarithms'],
      },
    };
    expect(estimateModules(withDiagnostic)).toBe(estimateModules(midSized) - 2);
  });
});

describe('queueing the work', () => {
  it('queues exactly one job for a subject with no lessons yet', () => {
    const topic = store.topics.create(intake);
    const job = orchestrator.enqueueTopic(topic.id);
    expect(job.kind).toBe('generate-topic');
    expect(job.status).toBe('queued');
    expect(store.jobs.claimNext()?.id).toBe(job.id);
    expect(store.jobs.claimNext()).toBeNull();
  });

  it('refuses to queue against a subject that does not exist', () => {
    expect(() => orchestrator.enqueueTopic(topicIdSchema.parse('t_0000000000000001'))).toThrowError();
    expect(store.jobs.claimNext()).toBeNull();
  });
});
