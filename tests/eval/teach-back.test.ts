// FRACTAL: covers F4 | type unit
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exampleEvalScript, exampleEvalVerdict, exampleTeachBackMisconception, type SessionId, type Topic } from '@/shapes';
import { assessTeachBack, gateTeachBackVerdict, teachBackPrompt } from '@/eval/teach-back';
import { bootHarness, evaluatorOutput, seedTopic, type Harness } from '@/eval/harness.testing';

const GOOD_ANSWER =
  'Entropy is not just the length of the message; it is the expected code length under an optimal code.';
const VAGUE_ANSWER = 'That sounds about right to me, yes.';

describe('teach-back assessment', () => {
  it('plants the misconception without leaking the correction', () => {
    const prompt = teachBackPrompt(exampleTeachBackMisconception);
    expect(prompt).toContain(exampleTeachBackMisconception.statement);
    expect(prompt).not.toContain(exampleTeachBackMisconception.correction);
  });

  it('passes only when the learner both names and corrects the misconception', () => {
    expect(assessTeachBack(GOOD_ANSWER, exampleTeachBackMisconception)).toEqual({
      identified: true,
      corrected: true,
      passed: true,
    });
    expect(assessTeachBack(VAGUE_ANSWER, exampleTeachBackMisconception).passed).toBe(false);

    const namedOnly = assessTeachBack(
      'The length of the message is the wrong idea here, entropy means something else.',
      exampleTeachBackMisconception,
    );
    expect(namedOnly.identified).toBe(true);
    expect(namedOnly.corrected).toBe(false);
    expect(namedOnly.passed).toBe(false);
  });

  it('downgrades a model pass the learner did not earn', () => {
    const claimed = { ...exampleEvalVerdict, outcome: 'pass' as const };
    expect(gateTeachBackVerdict(claimed, VAGUE_ANSWER, exampleTeachBackMisconception).verdict.outcome).toBe('continue');
    expect(gateTeachBackVerdict(claimed, GOOD_ANSWER, exampleTeachBackMisconception).verdict.outcome).toBe('pass');
  });
});

describe('F4 path: the re-ask served as teach-back', () => {
  let h: Harness;

  beforeEach(() => {
    h = bootHarness();
  });

  afterEach(async () => {
    await h.teardown();
  });

  async function reachTeachBack(): Promise<{ topic: Topic; sessionId: SessionId }> {
    const script = { ...exampleEvalScript, misconceptions: [exampleTeachBackMisconception] };
    const { topic, nodes } = seedTopic(h.store, { script });
    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });
    h.respondWith(() => evaluatorOutput({ reply: session.turns[0].text, outcome: 'fail' }));
    const first = await h.engine.send(
      session.id,
      { text: 'No idea, sorry.', selfAssessment: null },
    );
    expect(first.evaluatorTurn.mode).toBe('teach-back');
    return { topic, sessionId: session.id };
  }

  it('accepts the exchange when the learner corrects the planted misconception', async () => {
    const { sessionId } = await reachTeachBack();
    h.respondWith(() => evaluatorOutput({ reply: 'You caught it.', mode: 'verdict', outcome: 'pass' }));

    const result = await h.engine.send(
      sessionId,
      { text: GOOD_ANSWER, selfAssessment: null },
    );

    expect(result.verdict.outcome).toBe('pass');
    expect(result.verdict.assistLevel).toBe(1);
    expect(result.completion).not.toBeNull();
  });

  it('refuses the exchange when the learner only agrees with the confused student', async () => {
    const { topic, sessionId } = await reachTeachBack();
    h.respondWith(() => evaluatorOutput({ reply: 'Right, so we agree.', mode: 'verdict', outcome: 'pass' }));

    const result = await h.engine.send(
      sessionId,
      { text: VAGUE_ANSWER, selfAssessment: null },
    );

    expect(result.verdict.outcome).not.toBe('pass');
    expect(result.verdict.outcome).not.toBe('assisted-pass');
    expect(result.completion).toBeNull();
    expect(h.store.modules.graph(topic.id).nodes[0].state).toBe('available');
  });
});
