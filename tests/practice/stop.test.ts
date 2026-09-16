// FRACTAL: covers F8 | type unit
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { practiceSessionSchema, type SessionId } from '@/shapes';
import { AppError } from '@/core/errors';
import { answerPractice, startPractice, stopPractice } from '@/practice/session';
import { MAX_RETAINED_PRACTICE_SESSIONS } from '@/practice/store';
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

describe('F8 stopping a practice session mid-way', () => {
  it('keeps every answer already given and records that the learner stopped', () => {
    const { session } = startPractice(deps(), 6, at(30));

    answerPractice(deps(), session.id, 0, true, at(30));
    const afterTwo = answerPractice(deps(), session.id, 1, false, at(30));
    expect(afterTwo.answeredCount).toBe(2);

    const stopped = stopPractice(deps(), session.id);

    expect(stopped.stoppedEarly).toBe(true);
    expect(stopped.answeredCount).toBe(2);
    expect(stopped.questions[0]).toMatchObject({ answered: true, correct: true });
    expect(stopped.questions[1]).toMatchObject({ answered: true, correct: false });
    expect(stopped.questions.slice(2).every((q) => q.answered === false)).toBe(true);
    expect(practiceSessionSchema.safeParse(stopped).success).toBe(true);
    expect(h.practice.get(session.id)).toEqual(stopped);
  });

  it('moves the review schedule for each answered question, in both directions', () => {
    const { session } = startPractice(deps(), 4, at(30));
    const first = session.questions[0];
    const second = session.questions[1];
    const before = h.store.reviews.get(first.moduleId);
    expect(before).not.toBeNull();

    answerPractice(deps(), session.id, 0, true, at(30));
    answerPractice(deps(), session.id, 1, false, at(30));

    const advancedItem = h.store.reviews.get(first.moduleId);
    const missedItem = h.store.reviews.get(second.moduleId);
    expect(advancedItem?.intervalDays).toBeGreaterThan(before?.intervalDays ?? 0);
    expect(missedItem?.intervalDays).toBe(1);
    expect(missedItem?.flaggedNeedsReview).toBe(true);
  });

  it('refuses an out-of-range or repeated answer in the learner own words', () => {
    const { session } = startPractice(deps(), 3, at(30));

    expect(() => answerPractice(deps(), session.id, 99, true, at(30))).toThrowError(AppError);
    expect(() => answerPractice(deps(), session.id, -1, true, at(30))).toThrowError(AppError);
    answerPractice(deps(), session.id, 0, true, at(30));
    try {
      answerPractice(deps(), session.id, 0, false, at(30));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('conflict');
      expect((e as AppError).message).toBe('You already answered that one.');
    }
    expect(h.practice.get(session.id)?.answeredCount).toBe(1);
  });

  it('tells the learner plainly when the session is no longer open', () => {
    try {
      stopPractice(deps(), 's_0000000000000000' as SessionId);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('not-found');
      expect((e as AppError).message).toMatch(/no longer open/);
    }
  });

  it('keeps the retained-session map bounded', () => {
    for (let i = 0; i < MAX_RETAINED_PRACTICE_SESSIONS + 5; i += 1) {
      startPractice(deps(), 2, at(30));
    }
    expect(h.practice.size()).toBe(MAX_RETAINED_PRACTICE_SESSIONS);
  });
});
