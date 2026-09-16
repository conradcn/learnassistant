// FRACTAL: covers F4 | type unit
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exampleEvalScript } from '@/shapes';
import { EXHAUSTED_NOTE } from '@/eval/turn';
import { bootHarness, evaluatorOutput, seedTopic, type Harness } from '@/eval/harness.testing';

let h: Harness;

beforeEach(() => {
  h = bootHarness();
});

afterEach(async () => {
  await h.teardown();
});

// WHY: the exchange used to dead-end. Once the script's angles were spent every later
// turn produced the same sentence, so the learner typed into a conversation that had
// stopped answering. These pin the two halves of why it ran out and why it stayed stuck.
describe('F4: the socratic exchange keeps moving', () => {
  it('keeps asking new questions after the scripted angles run out', async () => {
    const { nodes } = seedTopic(h.store, {
      script: { ...exampleEvalScript, angles: ['a worked example', 'a case where it fails'], misconceptions: [] },
    });
    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });
    let n = 0;
    h.respondWith(() => {
      n += 1;
      return evaluatorOutput({ reply: `Question ${n}: ${'word'.repeat(1)} ${n} distinct subject matter here.`, angle: null });
    });

    const texts: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const result = await h.engine.send(session.id, { text: `attempt ${i}`, selfAssessment: null });
      texts.push(result.evaluatorTurn.text);
    }

    expect(new Set(texts).size).toBe(texts.length);
    expect(texts.some((t) => t.includes(EXHAUSTED_NOTE))).toBe(false);
  });

  it('spends no angle on a hint, so the ladder outlives the first question', async () => {
    const { nodes } = seedTopic(h.store, {
      script: { ...exampleEvalScript, angles: ['a worked example', 'a case where it fails'], misconceptions: [] },
    });
    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });
    let n = 0;
    h.respondWith(() => {
      n += 1;
      return evaluatorOutput({
        reply: `Hint ${n}: consider the ${n} boundary case before answering again.`,
        outcome: 'fail',
        misunderstanding: 'That is a definition, not a use.',
      });
    });

    for (let i = 0; i < 3; i += 1) {
      const result = await h.engine.send(session.id, { text: `attempt ${i}`, selfAssessment: null });
      expect(result.evaluatorTurn.mode).toBe('hint');
      expect(result.evaluatorTurn.angle).toBeNull();
    }
    const graph = h.store.evals.get(session.id);
    expect(graph?.turns.filter((t) => t.role === 'evaluator' && t.mode === 'question')).toHaveLength(1);
  });

  it('hands off to a practice lesson once, not on every later turn', async () => {
    const { nodes } = seedTopic(h.store, {
      script: { ...exampleEvalScript, angles: [], misconceptions: [] },
    });
    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });
    h.respondWith(() => evaluatorOutput({ reply: 'The very same question, word for word, again.', angle: null }));

    const texts: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = await h.engine.send(session.id, { text: `attempt ${i}`, selfAssessment: null });
      texts.push(result.evaluatorTurn.text);
    }

    expect(texts.filter((t) => t.includes(EXHAUSTED_NOTE))).toHaveLength(1);
    // The first repeat is what triggers the handoff; after it has been said, the
    // learner gets the evaluator's own reply back rather than the same sentence again.
    expect(texts.filter((t) => t.includes('The very same question'))).toHaveLength(3);
  });
});
