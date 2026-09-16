// FRACTAL: covers F4 | type unit
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exampleEvalScript, exampleEvalTurn, exampleTeachBackMisconception } from '@/shapes';
import { angleLedger, checkReask, chooseAngle, normalizeQuestion, similarity } from '@/eval/angles';
import { bootHarness, evaluatorOutput, seedTopic, type Harness } from '@/eval/harness.testing';

describe('the angle ledger and the near-duplicate check', () => {
  it('normalises away punctuation and casing before comparing', () => {
    expect(normalizeQuestion('Why is a FAIR coin one bit?')).toBe('why is a fair coin one bit');
    expect(similarity('Why is a fair coin one bit?', 'why is a FAIR coin one bit')).toBe(1);
    expect(similarity('Why is a fair coin one bit?', 'How would you compress a biased source?')).toBeLessThan(0.3);
  });

  it('lists used and remaining angles from the transcript', () => {
    const ledger = angleLedger(exampleEvalScript, [{ ...exampleEvalTurn, angle: 'compression' }]);
    expect(ledger.used).toEqual(['compression']);
    expect(ledger.available).toEqual(['gambling odds', 'twenty questions']);
    expect(chooseAngle(ledger, 'twenty questions')).toBe('twenty questions');
    expect(chooseAngle(ledger, 'compression')).toBe('gambling odds');
    expect(chooseAngle({ used: exampleEvalScript.angles, available: [] }, null)).toBeNull();
  });

  it('rejects a deliberately repeated question and an already-used angle', () => {
    const ledger = { used: ['compression'], available: ['gambling odds'] };
    const asked = ['Why is a fair coin one bit?'];

    expect(checkReask('Why is a fair coin one bit?', 'gambling odds', ledger, asked)).toEqual({
      ok: false,
      reason: 'near-duplicate',
      detail: 'the question repeats one already asked',
    });
    expect(checkReask('A brand new question about betting odds', 'compression', ledger, asked)).toMatchObject({
      ok: false,
      reason: 'angle-already-used',
    });
    expect(checkReask('A brand new question about betting odds', null, ledger, asked)).toMatchObject({
      ok: false,
      reason: 'no-angles-left',
    });
    expect(
      checkReask('How would you bet on the next symbol, and at what odds?', 'gambling odds', ledger, asked),
    ).toEqual({ ok: true, angle: 'gambling odds' });
  });
});

describe('F4 AC: a re-asked question is never a verbatim repeat', () => {
  let h: Harness;

  beforeEach(() => {
    h = bootHarness();
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('switches to teach-back when the evaluator tries to repeat itself', async () => {
    const script = { ...exampleEvalScript, misconceptions: [exampleTeachBackMisconception] };
    const { nodes } = seedTopic(h.store, { script });
    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });
    const opening = session.turns[0].text;
    h.respondWith(() => evaluatorOutput({ reply: opening, outcome: 'fail', angle: 'compression' }));

    const result = await h.engine.send(
      session.id,
      { text: 'I am not sure at all.', selfAssessment: null },
    );

    expect(result.evaluatorTurn.mode).toBe('teach-back');
    expect(result.evaluatorTurn.text).not.toBe(opening);
    expect(result.evaluatorTurn.text).toContain(exampleTeachBackMisconception.statement);
    expect(result.evaluatorTurn.angle).toBe(`teach-back:${exampleTeachBackMisconception.id}`);
  });

  it('asks for a remedial lesson rather than repeating when angles and teach-backs are gone', async () => {
    const script = { ...exampleEvalScript, angles: [], misconceptions: [] };
    const { topic, nodes } = seedTopic(h.store, { script });
    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });
    const opening = session.turns[0].text;
    h.respondWith(() => evaluatorOutput({ reply: opening, outcome: 'fail' }));

    const result = await h.engine.send(
      session.id,
      { text: 'Still lost, sorry.', selfAssessment: null },
    );

    expect(result.evaluatorTurn.text).not.toBe(opening);
    expect(result.verdict.remedialNeeded).toBe(true);
    expect(result.remedialQueued).toBe(true);
    expect(h.store.modules.graph(topic.id).nodes.some((n) => n.kind === 'remedial')).toBe(true);
  });
});
