// FRACTAL: covers F4 | type path optimistic-send
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { err } from '@/core/errors';
import { applyOptimisticSend, EMPTY_CHAT, rollbackSend, settleSend } from '@/eval/optimistic';
import { bootHarness, evaluatorOutput, seedTopic, type Harness } from '@/eval/harness.testing';

let h: Harness;

beforeEach(() => {
  h = bootHarness();
});

afterEach(async () => {
  await h.teardown();
});

describe('F4 optimistic send', () => {
  it('shows the message and re-enables the composer on the same tick, before the request settles', async () => {
    const { nodes } = seedTopic(h.store);
    let released = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    h.respondWith(() => evaluatorOutput({ reply: 'Keep going.', angle: 'compression' }));
    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });

    const message = { text: 'Entropy is an average over the distribution.', selfAssessment: null };
    const applied = applyOptimisticSend({ ...EMPTY_CHAT, composer: { text: message.text, enabled: true, error: null } }, message);

    // same tick: nothing has been awaited between the interaction and this view
    expect(applied.view.pending).toHaveLength(1);
    expect(applied.view.pending[0].text).toBe(message.text);
    expect(applied.view.composer.text).toBe('');
    expect(applied.view.composer.enabled).toBe(true);

    const inFlight = h.engine
      .send(session.id, message)
      .then((r) => settleSend(applied.view, applied.key, r));
    released();
    await gate;

    const settled = await inFlight;
    expect(settled.pending).toHaveLength(0);
    expect(settled.turns.some((t) => t.role === 'learner' && t.text === message.text)).toBe(true);
    expect(settled.composer.enabled).toBe(true);
  });

  it('rolls the message back into the composer and surfaces the error when the send fails', async () => {
    const message = { text: 'A fair coin is one bit.', selfAssessment: null };
    const applied = applyOptimisticSend(EMPTY_CHAT, message);

    const rolled = rollbackSend(
      applied.view,
      applied.key,
      err('cli-failed', { userMessage: 'The evaluator did not respond. Press Retry to send it again.' }),
    );

    expect(rolled.pending).toHaveLength(0);
    expect(rolled.turns).toHaveLength(0);
    expect(rolled.composer.text).toBe(message.text);
    expect(rolled.composer.enabled).toBe(true);
    expect(rolled.composer.error).toBe('The evaluator did not respond. Press Retry to send it again.');
    expect(rolled.composer.error).not.toContain('cli-failed');
  });

  it('accepts a second message while the first is still in flight', () => {
    const first = applyOptimisticSend(EMPTY_CHAT, { text: 'First answer, still sending.', selfAssessment: null });
    const second = applyOptimisticSend(first.view, { text: 'Second answer, typed right after.', selfAssessment: null });

    expect(second.view.pending.map((p) => p.text)).toEqual([
      'First answer, still sending.',
      'Second answer, typed right after.',
    ]);
    expect(second.key).not.toBe(first.key);
    expect(second.view.composer.enabled).toBe(true);
  });
});
