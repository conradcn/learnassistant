// FRACTAL: covers F4 | type unit
import { describe, expect, it } from 'vitest';
import { defaultScript, deStage, isStageDirection, openingSeed } from '@/eval/session';
import type { EvalScript } from '@/shapes';

const fallback = defaultScript('Entropy');

function scriptWith(seeds: string[]): EvalScript {
  return { ...fallback, seedQuestions: seeds };
}

describe('the opening question is a message to the learner', () => {
  it('recognises a stage direction by its third-person reference, not by its mood', () => {
    expect(isStageDirection('Hand the learner a fresh equation. Ask: what shape is it?')).toBe(true);
    expect(isStageDirection('Ask them whether the bound still holds.')).toBe(true);
    expect(deStage('Ask them whether the bound still holds.')).toBe('Tell me whether the bound still holds.');
    expect(isStageDirection('Give an example of a distribution with infinite variance.')).toBe(false);
    expect(isStageDirection('Which symbols are free, and which are bound?')).toBe(false);
  });

  it('re-addresses the direction to the learner and keeps the equation in it', () => {
    const seed =
      'Hand the learner a fresh equation, e.g. $\mathcal{L}(\theta) = \lambda \lVert \theta \rVert_2^2$. ' +
      'Ask: which symbols are free, which are bound, and what is the shape of every piece?';
    const out = deStage(seed);
    expect(out).not.toMatch(/the learner/i);
    expect(out).not.toMatch(/e\.g\./i);
    expect(out).toContain('\lVert \theta \rVert_2^2');
    expect(out).toContain('Which symbols are free');
  });

  it('sends a well-written seed through untouched', () => {
    const seed = 'In $p_\theta(x_t \mid x_{<t})$, explain the role of each decoration.';
    expect(openingSeed(scriptWith([seed]), fallback)).toBe(seed);
  });

  it('prefers rewriting the authored opener over jumping to a later seed', () => {
    const script = scriptWith(['Ask the learner to type the loss.', 'A different, narrower question?']);
    expect(openingSeed(script, fallback)).toBe('Type the loss.');
  });

  it('falls back to a learner-facing sibling, then to the generic opener', () => {
    expect(openingSeed(scriptWith(['Ask them.', 'What breaks first?']), fallback)).toBe('What breaks first?');
    expect(openingSeed(scriptWith([]), fallback)).toBe(fallback.seedQuestions[0]);
  });
});
