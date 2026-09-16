// FRACTAL: covers F4 | type path eval-session-lifecycle
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootHarness, evaluatorOutput, seedTopic, type Harness } from '@/eval/harness.testing';

let h: Harness;

beforeEach(() => {
  h = bootHarness();
});

afterEach(async () => {
  await h.teardown();
});

describe('F4 lifecycle: an evaluation turn never outlives its owner', () => {
  it('cancelling an in-flight turn clears the in-flight flag and releases the per-session mutex', async () => {
    const { nodes } = seedTopic(h.store);
    let arrived = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let hold = true;
    h.respondWith(() => {
      arrived();
      if (hold) {
        const until = Date.now() + 40;
        while (Date.now() < until) {
          /* the transport is synchronous; hold the turn open long enough to cancel it */
        }
      }
      return evaluatorOutput({ reply: 'Keep going.', angle: 'compression' });
    });

    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });
    const first = h.engine.send(
      session.id,
      { text: 'Entropy measures expected surprise across the distribution.', selfAssessment: null },
    );
    await started;
    expect(h.engine.activeSessions()).toBe(1);
    h.engine.cancel(session.id);
    await first.catch(() => undefined);

    expect(h.engine.activeSessions()).toBe(0);

    hold = false;
    const second = await h.engine.send(
      session.id,
      { text: 'Trying again after navigating back.', selfAssessment: null },
    );
    expect(second.evaluatorTurn.role).toBe('evaluator');
  });

  it('closing the engine cancels every in-flight turn and refuses new ones', async () => {
    const { nodes } = seedTopic(h.store);
    h.respondWith(() => evaluatorOutput({ reply: 'Keep going.', angle: 'compression' }));
    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });
    await h.engine.send(
      session.id,
      { text: 'Entropy is the expected code length.', selfAssessment: null },
    );

    await h.engine.close();
    expect(h.engine.activeSessions()).toBe(0);

    await expect(
      h.engine.send(
        session.id,
        { text: 'One more after teardown.', selfAssessment: null },
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });
});
