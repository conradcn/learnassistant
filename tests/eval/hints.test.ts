// FRACTAL: covers F4 | type unit
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exampleEvalVerdict, isoDateStringSchema, type EvalVerdict } from '@/shapes';
import { applyHintLadder, cappedAssistLevel, escalate } from '@/eval/hints';
import { bootHarness, evaluatorOutput, seedTopic, type Harness } from '@/eval/harness.testing';
import { firstIntervalDays } from '@/review/schedule';

function verdict(outcome: EvalVerdict['outcome'], assistLevel: 0 | 1 | 2 | 3): EvalVerdict {
  return { ...exampleEvalVerdict, outcome, assistLevel };
}

describe('the graduated hint ladder', () => {
  it('turns a first struggle into a hint, not a failure', () => {
    const out = applyHintLadder(verdict('fail', 0), 0);
    expect(out.verdict.outcome).toBe('continue');
    expect(out.mode).toBe('hint');
    expect(out.verdict.assistLevel).toBe(1);
  });

  it('escalates one level per struggle and only fails once the ladder runs out', () => {
    expect(applyHintLadder(verdict('fail', 0), 1).verdict.assistLevel).toBe(2);
    expect(applyHintLadder(verdict('fail', 0), 2).verdict.assistLevel).toBe(3);
    const exhausted = applyHintLadder(verdict('fail', 0), 3);
    expect(exhausted.verdict.outcome).toBe('fail');
    expect(exhausted.verdict.assistLevel).toBe(3);
    expect(escalate(3)).toBe(3);
  });

  it('lets a continuing turn claim at most one more rung than it has climbed', () => {
    // WHY: the level is a running max and 2 is the assisted-pass threshold, so an
    // evaluator that jumps 0 -> 2 mid-conversation spends no light hint and quietly
    // takes a clean pass off the table for the rest of the session.
    expect(applyHintLadder(verdict('continue', 2), 0).verdict.assistLevel).toBe(1);
    expect(applyHintLadder(verdict('continue', 3), 1).verdict.assistLevel).toBe(2);
    expect(applyHintLadder(verdict('continue', 0), 2).verdict.assistLevel).toBe(2);
    expect(cappedAssistLevel(3, 3)).toBe(3);
  });

  it('records a pass earned with heavy hints as assisted-pass', () => {
    expect(applyHintLadder(verdict('pass', 0), 2).verdict.outcome).toBe('assisted-pass');
    expect(applyHintLadder(verdict('pass', 0), 1).verdict.outcome).toBe('pass');
    // WHY it is not capped here, unlike a continuing turn: on a pass the reported
    // level is what the whole exchange cost, and clamping it would relabel an
    // assisted pass as a clean one.
    expect(applyHintLadder(verdict('pass', 3), 0).verdict.outcome).toBe('assisted-pass');
    expect(applyHintLadder(verdict('pass', 3), 0).verdict.assistLevel).toBe(3);
  });
});

describe('F4 path: pass with heavy hints', () => {
  let h: Harness;

  beforeEach(() => {
    h = bootHarness();
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('persists assisted-pass and hands the assist level to the review scheduler', async () => {
    const { topic, nodes } = seedTopic(h.store);
    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });
    let call = 0;

    h.respondWith(() => {
      call += 1;
      if (call <= 2) {
        return evaluatorOutput({
          reply: `Not quite — for attempt number ${call}, think about long runs of many symbols instead.`,
          outcome: 'fail',
          misunderstanding: 'You are treating entropy as a property of one symbol.',
        });
      }
      return evaluatorOutput({ reply: 'Yes — that is it.', mode: 'verdict', outcome: 'pass' });
    });

    const first = await h.engine.send(
      session.id,
      { text: 'It is the length of the message.', selfAssessment: null },
    );
    expect(first.verdict.outcome).toBe('continue');
    expect(first.evaluatorTurn.mode).toBe('hint');
    expect(first.evaluatorTurn.text).toContain('You are treating entropy as a property of one symbol.');

    const second = await h.engine.send(
      session.id,
      { text: 'It is bits per symbol then.', selfAssessment: null },
    );
    expect(second.verdict.assistLevel).toBe(2);

    const third = await h.engine.send(
      session.id,
      { text: 'It is the expectation of the surprise over the distribution.', selfAssessment: null },
    );
    expect(third.verdict.outcome).toBe('assisted-pass');
    expect(third.verdict.assistLevel).toBe(2);
    expect(h.store.modules.graph(topic.id).nodes[0].state).toBe('assisted-pass');

    const due = h.store.reviews.due(isoDateStringSchema.parse('2030-01-01T00:00:00.000Z'), 10);
    const item = due.find((r) => r.moduleId === nodes[0].id);
    expect(item).toBeDefined();
    expect(item?.lastAssistLevel).toBe(2);
    // F7's rule is that an assisted pass starts sooner than a clean one, not that it starts
    // on any particular day count: the first interval is now derived from the memory model
    // (`hard` vs `good`), so this asserts the rule rather than the number it happens to be.
    expect(item?.intervalDays).toBe(firstIntervalDays(2));
    expect(item?.intervalDays).toBeLessThan(firstIntervalDays(0));

    const persistedLevels = h.store.evals
      .get(session.id)
      ?.turns.filter((t) => t.role === 'evaluator' && t.assistLevel !== null)
      .map((t) => t.assistLevel);
    expect(persistedLevels).toContain(1);
    expect(persistedLevels).toContain(2);
  });
});
