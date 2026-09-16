// FRACTAL: covers F7 | type integration
/**
 * The one review outcome that does not travel through `completeModule`.
 *
 * `completeModule` refuses a non-passing verdict, so a review taken through C6's evaluator
 * chat and failed reaches C7 only via the hook in `runTurn`. Without that hook the
 * "review failed -> Again" row of the grade table in `docs/spaced-repetition.md` §3 would
 * have no caller at all, and a failed review would leave the schedule growing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReviewItem } from '@/shapes';
import { bootHarness, evaluatorOutput, seedTopic, type Harness } from '@/eval/harness.testing';
import { scheduleOnCompletion } from '@/review/schedule';

let h: Harness;

beforeEach(() => {
  h = bootHarness();
});

afterEach(async () => {
  await h.teardown();
});

/** Fail every turn, which walks the hint ladder to its end and then returns a real `fail`. */
function alwaysFails(): void {
  h.respondWith(() =>
    evaluatorOutput({
      reply: 'Not yet — that is the definition of the code length, not of the entropy.',
      outcome: 'fail',
      misunderstanding: 'You are still reading entropy off a single symbol.',
    }),
  );
}

/** Send until the ladder is exhausted and the terminal `fail` verdict comes back. */
async function failUntilTerminal(sessionId: string, attempts = 5): Promise<string[]> {
  const outcomes: string[] = [];
  for (let i = 0; i < attempts; i += 1) {
    const turn = await h.engine.send(sessionId as never, {
      text: `Attempt ${i + 1}: it is the number of bits in the message.`,
      selfAssessment: null,
    });
    outcomes.push(turn.verdict.outcome);
  }
  return outcomes;
}

describe('F7: a review failed in the evaluator chat', () => {
  it('shortens the interval, records a lapse and re-flags the lesson', async () => {
    const { topic, nodes } = seedTopic(h.store);
    // A module that has been passed once and has since built up a long interval.
    let item: ReviewItem = scheduleOnCompletion(h.store, nodes[0].id, 0);
    item = { ...item, intervalDays: 60, memory: { ...item.memory, stability: 60 } };
    h.store.reviews.upsert(item);
    h.store.modules.setState(nodes[0].id, 'completed');

    const session = h.engine.open('review', { kind: 'review', moduleId: nodes[0].id });
    alwaysFails();
    const outcomes = await failUntilTerminal(session.id);

    // The ladder converts the early failures into hints; only the exhausted ladder fails.
    expect(outcomes).toContain('fail');

    const after = h.store.reviews.get(nodes[0].id);
    expect(after).not.toBeNull();
    const recorded = after as ReviewItem;
    expect(recorded.intervalDays).toBeLessThan(60);
    expect(recorded.memory.stability).toBeLessThan(60);
    expect(recorded.lapses).toBe(1);
    expect(recorded.flaggedNeedsReview).toBe(true);
    expect(h.store.modules.graph(topic.id).nodes[0].state).toBe('needs-review');
  });

  it('counts one lapse however many times the learner tries after the ladder runs out', async () => {
    const { nodes } = seedTopic(h.store);
    h.store.reviews.upsert({ ...scheduleOnCompletion(h.store, nodes[0].id, 0), intervalDays: 60 });
    h.store.modules.setState(nodes[0].id, 'completed');

    const session = h.engine.open('review', { kind: 'review', moduleId: nodes[0].id });
    alwaysFails();
    const outcomes = await failUntilTerminal(session.id, 7);

    // Every turn past the ladder's end is also a `fail`, so this only holds because the
    // hook fires on the first one.
    expect(outcomes.filter((o) => o === 'fail').length).toBeGreaterThan(1);
    expect(h.store.reviews.get(nodes[0].id)?.lapses).toBe(1);
  });

  it('leaves a module that was never scheduled alone rather than throwing away the turn', async () => {
    const { nodes } = seedTopic(h.store);
    h.store.modules.setState(nodes[0].id, 'completed');
    expect(h.store.reviews.get(nodes[0].id)).toBeNull();

    const session = h.engine.open('review', { kind: 'review', moduleId: nodes[0].id });
    alwaysFails();
    const outcomes = await failUntilTerminal(session.id);

    expect(outcomes).toContain('fail');
    expect(h.store.reviews.get(nodes[0].id)).toBeNull();
  });

  it('does not touch the schedule when a first-pass module session fails', async () => {
    // A `module` target is not a retrieval attempt against an existing memory, so an
    // exhausted ladder there is not a lapse — there is nothing scheduled to lapse yet.
    const { nodes } = seedTopic(h.store);
    const scheduled = scheduleOnCompletion(h.store, nodes[0].id, 0);

    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });
    alwaysFails();
    await failUntilTerminal(session.id);

    expect(h.store.reviews.get(nodes[0].id)).toEqual(scheduled);
  });
});
