// FRACTAL: covers F4 | type unit
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unansweredMessage } from '@/eval/session';
import { bootHarness, evaluatorOutput, seedTopic, type Harness } from '@/eval/harness.testing';

let h: Harness;

beforeEach(() => {
  h = bootHarness();
});

afterEach(async () => {
  await h.teardown();
});

// WHY: the learner's turn is written before the model is called, so anything that kills
// the request in between leaves a saved question with no answer and nothing running to
// produce one. Nothing used to notice: the transcript ended on the learner, the composer
// sat under it, and the conversation was over without saying so. These pin the rule that
// an open conversation whose last word is the learner's is work still owed.
describe('F4: a conversation never rests on the learner', () => {
  it('finishes the interrupted turn on the next open instead of stranding it', async () => {
    const { nodes } = seedTopic(h.store);
    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });

    h.respondWith(() => {
      throw new Error('the evaluator process died mid turn');
    });
    await expect(h.engine.send(session.id, { text: 'entropy is the average surprise', selfAssessment: null }))
      .rejects.toThrow();

    const stranded = h.engine.resume(session.id);
    expect(stranded.turns[stranded.turns.length - 1].role).toBe('learner');
    expect(unansweredMessage(stranded)?.text).toBe('entropy is the average surprise');

    h.respondWith(() => evaluatorOutput({ reply: 'Good — now where does that average come from?' }));
    const result = await h.engine.continueTurn(session.id);

    expect(result).not.toBeNull();
    const turns = h.engine.resume(session.id).turns;
    expect(turns.filter((t) => t.role === 'learner')).toHaveLength(1);
    expect(turns[turns.length - 1].role).toBe('evaluator');
    expect(unansweredMessage(h.engine.resume(session.id))).toBeNull();
  });

  it('answers nothing when the transcript is not waiting on a reply', async () => {
    const { nodes } = seedTopic(h.store);
    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });
    expect(await h.engine.continueTurn(session.id)).toBeNull();
  });

  it('retrying the same text finishes the saved turn rather than doubling it', async () => {
    const { nodes } = seedTopic(h.store);
    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });

    h.respondWith(() => {
      throw new Error('the evaluator process died mid turn');
    });
    await expect(h.engine.send(session.id, { text: 'a code length is a log probability', selfAssessment: null }))
      .rejects.toThrow();

    h.respondWith(() => evaluatorOutput({ reply: 'Say more about which probability.' }));
    await h.engine.send(session.id, { text: 'a code length is a log probability', selfAssessment: null });

    const turns = h.engine.resume(session.id).turns;
    expect(turns.filter((t) => t.role === 'learner')).toHaveLength(1);
    expect(turns[turns.length - 1].role).toBe('evaluator');
  });
});
