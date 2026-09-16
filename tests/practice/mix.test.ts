// FRACTAL: covers F8 | type integration
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { practiceSessionSchema, type ModuleId, type TopicId } from '@/shapes';
import { AppError } from '@/core/errors';
import { mix, mixPlanSchema, perTopicCap, type PracticeCandidate } from '@/practice/mix';
import { NOTHING_COMPLETED_MESSAGE, practiceView, startPractice } from '@/practice/session';
import { at, bootC7, NOW, seedCompletedTopic, type C7Harness } from '@/review/harness.testing';

let h: C7Harness;

beforeEach(() => {
  h = bootC7();
});

afterEach(() => {
  h.teardown();
});

function candidate(topic: string, i: number, due = false): PracticeCandidate {
  return {
    moduleId: `m_${topic}${String(i).padStart(14, '0')}` as ModuleId,
    topicId: `t_${topic}${String(0).padStart(14, '0')}` as TopicId,
    moduleTitle: `Lesson ${i}`,
    question: `Question ${topic}${i}`,
    due,
    dueAt: null,
  };
}

describe('F8 interleaved practice mix', () => {
  it('never draws every question from one topic when two topics qualify', () => {
    const pool = [
      ...Array.from({ length: 10 }, (_, i) => candidate('aa', i, true)),
      ...Array.from({ length: 10 }, (_, i) => candidate('bb', i)),
    ];

    const { plan, picks } = mix(pool, 8);

    expect(plan.total).toBe(8);
    expect(picks).toHaveLength(8);
    expect(plan.perTopic).toHaveLength(2);
    expect(plan.fellBackToSingleTopic).toBe(false);
    for (const row of plan.perTopic) expect(row.count).toBeLessThanOrEqual(perTopicCap(8));
    expect(new Set(picks.map((p) => p.topicId)).size).toBe(2);
    expect(mixPlanSchema.safeParse(plan).success).toBe(true);
  });

  it('falls back to a single-topic session with no error when only one topic qualifies', () => {
    const pool = Array.from({ length: 6 }, (_, i) => candidate('aa', i));

    const { plan, picks } = mix(pool, 5);

    expect(plan.fellBackToSingleTopic).toBe(true);
    expect(plan.total).toBe(5);
    expect(plan.perTopic).toEqual([{ topicId: pool[0].topicId, count: 5 }]);
    expect(picks).toHaveLength(5);
  });

  it('prefers material that is already due before topping up with the rest', () => {
    const pool = [
      candidate('aa', 0),
      candidate('aa', 1, true),
      candidate('bb', 0, true),
      candidate('bb', 1),
    ];

    const { picks } = mix(pool, 2);

    expect(picks.every((p) => p.due)).toBe(true);
  });

  it('builds a mixed session from real completed modules across two subjects', () => {
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

    const { session, plan } = startPractice({ store: h.store, practice: h.practice }, 6, at(30));

    expect(practiceSessionSchema.safeParse(session).success).toBe(true);
    expect(session.questions).toHaveLength(6);
    expect(new Set(session.questions.map((q) => q.topicId)).size).toBe(2);
    for (const row of plan.perTopic) expect(row.count).toBeLessThanOrEqual(perTopicCap(6));
    expect(session.questions.every((q) => q.answered === false && q.correct === null)).toBe(true);
    expect(new Set(session.questions.map((q) => q.text)).size).toBeGreaterThan(1);
  });

  it('practises a single subject without complaining when only one has completed lessons', () => {
    seedCompletedTopic(h.store, {
      subject: 'Information theory',
      titles: ['Entropy', 'Codes'],
      completed: 2,
      idPrefix: 'aa',
    });
    seedCompletedTopic(h.store, {
      subject: 'Bayesian statistics',
      titles: ['Priors'],
      completed: 0,
      idPrefix: 'bb',
    });

    const { session, plan } = startPractice({ store: h.store, practice: h.practice }, 5, at(30));

    expect(plan.fellBackToSingleTopic).toBe(true);
    expect(session.questions).toHaveLength(2);
    expect(new Set(session.questions.map((q) => q.topicId)).size).toBe(1);
  });

  it('says nothing is completed yet, distinctly from a failure, when the pool is empty', () => {
    seedCompletedTopic(h.store, { titles: ['Entropy'], completed: 0, idPrefix: 'cc' });
    const deps = { store: h.store, practice: h.practice };

    const view = practiceView(deps, 5, NOW);

    expect(view.kind).toBe('empty');
    expect(view.kind === 'empty' ? view.message : '').toBe(NOTHING_COMPLETED_MESSAGE);

    let caught: unknown = null;
    try {
      startPractice(deps, 5, NOW);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('conflict');
    expect(h.practice.size()).toBe(0);
  });

  it('reports a read failure as a failure, not as an empty shelf', () => {
    const broken = {
      store: {
        ...h.store,
        topics: {
          ...h.store.topics,
          list: () => {
            throw new AppError('store-corrupt', 'Something went wrong reading your saved data.', 'c_test');
          },
        },
      },
      practice: h.practice,
    } as Parameters<typeof practiceView>[0];

    const view = practiceView(broken, 5, NOW);

    expect(view.kind).toBe('failed');
    expect(view.kind === 'failed' ? view.message : '').toContain('saved data');
  });
});
