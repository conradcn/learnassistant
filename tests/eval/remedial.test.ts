// FRACTAL: covers F4 | type integration
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  exampleEvalVerdict,
  exampleJob,
  exampleModuleId,
  exampleTopic,
  type Job,
  type ModuleId,
} from '@/shapes';
import { AppError } from '@/core/errors';
import {
  DECLINED_MESSAGE,
  REMEDIAL_FAILURE_THRESHOLD,
  conceptFor,
  requestRemedial,
  shouldRequestRemedial,
} from '@/eval/remedial';
import { bootHarness, evaluatorOutput, seedTopic, type Harness } from '@/eval/harness.testing';

describe('the remedial trigger rule', () => {
  it('fires on the third consecutive failure, or when the evaluator asks for it', () => {
    expect(shouldRequestRemedial(2, exampleEvalVerdict)).toBe(false);
    expect(shouldRequestRemedial(REMEDIAL_FAILURE_THRESHOLD, exampleEvalVerdict)).toBe(true);
    expect(shouldRequestRemedial(0, { ...exampleEvalVerdict, remedialNeeded: true })).toBe(true);
  });

  it('names the concept from the recorded misunderstanding, falling back to the lesson title', () => {
    expect(conceptFor(exampleEvalVerdict, 'Entropy')).toBe(exampleEvalVerdict.misunderstanding);
    expect(conceptFor({ ...exampleEvalVerdict, misunderstanding: null }, 'Entropy')).toBe('Entropy');
  });
});

describe('a declined remedial request is spoken plainly, never silently retried', () => {
  const calls: ModuleId[] = [];
  const orchestrator = {
    requestRemedial(moduleId: ModuleId): Job {
      calls.push(moduleId);
      return exampleJob;
    },
  };

  it('refuses outright when the subject already needs attention', () => {
    calls.length = 0;
    const outcome = requestRemedial(
      orchestrator,
      { ...exampleTopic, status: 'needs-attention' },
      exampleModuleId,
      'entropy is not per-symbol',
    );
    expect(outcome).toEqual({ queued: false, reason: 'declined', message: DECLINED_MESSAGE });
    expect(calls).toHaveLength(0);
  });

  it('offers to keep going with hints when the request cannot be queued', () => {
    calls.length = 0;
    const refusing = {
      requestRemedial: (): Job => {
        throw new AppError('cli-missing', 'The lesson writer is not available.', 'c_test');
      },
    };
    const outcome = requestRemedial(refusing, exampleTopic, exampleModuleId, 'entropy');
    expect(outcome.queued).toBe(false);
    expect(outcome.message).toContain('keep going here with hints');
    expect(calls).toHaveLength(0);
  });
});

describe('F4 path: repeated failures trigger a remedial mini-module, then a re-ask', () => {
  let h: Harness;

  beforeEach(() => {
    h = bootHarness();
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('queues new instructional input instead of looping the same question', async () => {
    const { topic, nodes } = seedTopic(h.store);
    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });
    let call = 0;
    h.respondWith(() => {
      call += 1;
      return evaluatorOutput({
        reply: `Attempt ${call}: consider instead how many yes-or-no questions numbered ${call} you would need here.`,
        outcome: 'fail',
        misunderstanding: 'You keep treating entropy as a per-symbol constant.',
      });
    });

    const results = [];
    for (let i = 0; i < 6; i += 1) {
      results.push(
        await h.engine.send(
          session.id,
          { text: `My ${i}th attempt at explaining this.`, selfAssessment: null },
        ),
      );
    }

    expect(results.slice(0, 5).every((r) => r.remedialQueued === false)).toBe(true);
    expect(results[5].remedialQueued).toBe(true);

    const graph = h.store.modules.graph(topic.id);
    const remedial = graph.nodes.find((n) => n.kind === 'remedial');
    expect(remedial).toBeDefined();
    expect(remedial?.title).toContain('per-symbol constant');
    expect(graph.edges.some((e) => e.from === nodes[0].id && e.to === remedial?.id)).toBe(true);

    const transcript = h.store.evals.get(session.id);
    expect(transcript?.turns[transcript.turns.length - 1].text).toContain('short practice lesson');
    // the streak resets once new instructional input is on the way
    expect(results[5].session.consecutiveFailures).toBe(0);

    const questionsAsked = (transcript?.turns ?? []).filter((t) => t.role === 'evaluator').map((t) => t.text);
    expect(new Set(questionsAsked).size).toBe(questionsAsked.length);
  });
});
