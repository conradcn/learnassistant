// FRACTAL: covers F4 | type unit
import { describe, expect, it } from 'vitest';
import { parseEvaluatorOutput } from '@/eval/verdict-parse';

// The reply is real: a Claude evaluate session on "Vectors as Points in R^n" answered
// well, judged the answer, and left `remedialNeeded` out of the JSON. Zod called it
// Required, the turn was thrown away as a CLI failure, and the learner was told the
// evaluator had gone silent — on every reopen, because the message it was answering was
// already saved and kept being re-asked.
const REAL_REPLY = {
  reply: "That's right — the inner $768$ cancels and you're left with $50257$ logits.",
  mode: 'question',
  angle: 'Push past shape arithmetic to the definition of a vector as an ordered tuple',
  verdict: {
    outcome: 'continue',
    assistLevel: 0,
    misunderstanding: null,
    nextAngle: 'Whether the shape match is understood as what makes the subtraction legal',
    rationale: 'Shape derivation is correct and cites the cancelling inner dimension.',
  },
};

describe('F4: an evaluator reply missing a bookkeeping field', () => {
  it('keeps the turn when remedialNeeded is absent, reading it as no remedial asked for', () => {
    const parsed = parseEvaluatorOutput(REAL_REPLY);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.verdict.remedialNeeded).toBe(false);
    expect(parsed.value.reply).toContain('50257');
  });

  it('reads every other absent bookkeeping field as its inert value', () => {
    const parsed = parseEvaluatorOutput({ reply: 'Say more.', mode: 'question', verdict: { outcome: 'continue' } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.angle).toBeNull();
    expect(parsed.value.verdict).toMatchObject({
      assistLevel: 0,
      misunderstanding: null,
      nextAngle: null,
      remedialNeeded: false,
      rationale: '',
    });
  });

  // WHY this one still fails: an omitted reply has no inert reading — there is nothing to
  // show the learner, so there is no turn to keep.
  it('still refuses a reply-less output', () => {
    expect(parseEvaluatorOutput({ mode: 'question', verdict: { outcome: 'continue' } }).ok).toBe(false);
  });

  // WHY it matters that this is not silently generous: a missing rationale means no
  // evidence, and a pass with no evidence is not granted. `enforcePassCriteria` is what
  // enforces that, and it needs the empty string to reach it rather than a lost turn.
  it('lets a rationale-less pass through the schema so the criteria gate can refuse it', () => {
    const parsed = parseEvaluatorOutput({ reply: 'Well done.', mode: 'verdict', verdict: { outcome: 'pass' } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.verdict.rationale).toBe('');
  });
});
