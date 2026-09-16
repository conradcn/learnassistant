// FRACTAL: covers F8 | type path optimistic-practice-answer
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '@/core/errors';
import {
  applyOptimisticAnswer,
  practiceAnswerView,
  rollbackAnswer,
  settleAnswer,
} from '@/practice/optimistic';
import { answerPractice, startPractice } from '@/practice/session';
import { at, bootC7, seedCompletedTopic, type C7Harness } from '@/review/harness.testing';

let h: C7Harness;

function deps(): { store: C7Harness['store']; practice: C7Harness['practice'] } {
  return { store: h.store, practice: h.practice };
}

beforeEach(() => {
  h = bootC7();
  seedCompletedTopic(h.store, {
    subject: 'Information theory',
    titles: ['Entropy', 'Codes', 'Channels'],
    completed: 3,
    idPrefix: 'aa',
  });
  seedCompletedTopic(h.store, {
    subject: 'Bayesian statistics',
    titles: ['Priors', 'Likelihood', 'Posteriors'],
    completed: 3,
    idPrefix: 'bb',
  });
});

afterEach(() => {
  h.teardown();
});

describe('F8 optimistic practice answers', () => {
  it('marks the answer on the same tick, before the write is started', async () => {
    const { session } = startPractice(deps(), 4, at(30));
    const view = practiceAnswerView(session);

    const applied = applyOptimisticAnswer(view, 1, true);

    // same tick: nothing has been awaited between the click and this view
    expect(applied.view.session.questions[1]).toMatchObject({ answered: true, correct: true });
    expect(applied.view.session.answeredCount).toBe(1);
    expect(applied.view.pending).toHaveLength(1);
    expect(applied.view.error).toBeNull();
    expect(view.session.questions[1].answered).toBe(false);

    const server = await Promise.resolve().then(() => answerPractice(deps(), session.id, 1, true, at(30)));
    const settled = settleAnswer(applied.view, applied.key, server);

    expect(settled.pending).toHaveLength(0);
    expect(settled.session.questions[1]).toMatchObject({ answered: true, correct: true });
    expect(settled.session.answeredCount).toBe(1);
  });

  it('lets a second answer be marked while the first write is still in flight', () => {
    const { session } = startPractice(deps(), 4, at(30));
    const first = applyOptimisticAnswer(practiceAnswerView(session), 0, true);
    const second = applyOptimisticAnswer(first.view, 1, false);

    expect(second.view.pending.map((p) => p.index)).toEqual([0, 1]);
    expect(second.view.session.answeredCount).toBe(2);
    expect(second.key).not.toBe(first.key);
  });

  it('rolls the mark back and surfaces the reason when the write fails', async () => {
    const { session } = startPractice(deps(), 4, at(30));
    const view = practiceAnswerView(session);
    const applied = applyOptimisticAnswer(view, 2, false);

    let caught: AppError | null = null;
    try {
      await Promise.resolve().then(() => answerPractice(deps(), session.id, 99, false, at(30)));
    } catch (e) {
      caught = e as AppError;
    }
    expect(caught).toBeInstanceOf(AppError);

    const rolled = rollbackAnswer(applied.view, applied.key, caught as AppError);

    expect(rolled.session.questions[2]).toMatchObject({ answered: false, correct: null });
    expect(rolled.session.answeredCount).toBe(0);
    expect(rolled.pending).toHaveLength(0);
    expect(rolled.error).toBe((caught as AppError).message);
    expect(rolled.error).not.toMatch(/\.ts|sqlite|stack/i);
  });

  it('rolls back only the failed answer, keeping the ones that succeeded', () => {
    const { session } = startPractice(deps(), 4, at(30));
    const first = applyOptimisticAnswer(practiceAnswerView(session), 0, true);
    const second = applyOptimisticAnswer(first.view, 1, false);

    const rolled = rollbackAnswer(
      second.view,
      second.key,
      new AppError('internal', 'Could not save that answer.', 'c_test'),
    );

    expect(rolled.session.questions[0]).toMatchObject({ answered: true, correct: true });
    expect(rolled.session.questions[1]).toMatchObject({ answered: false, correct: null });
    expect(rolled.session.answeredCount).toBe(1);
    expect(rolled.pending.map((p) => p.index)).toEqual([0]);
    expect(rolled.error).toBe('Could not save that answer.');
  });
});
