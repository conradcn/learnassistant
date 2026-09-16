// FRACTAL: covers F7 | type unit
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exampleEvalVerdict, scheduleParamsSchema, type AssistLevel } from '@/shapes';
import {
  ASSISTED_THRESHOLD,
  DEFAULT_SCHEDULE_PARAMS,
  firstIntervalDays,
  gradeForCompletion,
  recordReview,
  scheduleOnCompletion,
} from '@/review/schedule';
import { at, bootC7, NOW, seedCompletedTopic, type C7Harness } from '@/review/harness.testing';

let h: C7Harness;

beforeEach(() => {
  h = bootC7();
});

afterEach(() => {
  h.teardown();
});

describe('F7 assist-level weighting', () => {
  it('grades an assisted pass as harder than an unassisted one, and never as a failure', () => {
    // The first schedule is an encoding event, not a retrieval attempt, so no level of
    // help records a lapse. See docs/spaced-repetition.md §3.
    expect(gradeForCompletion(0)).toBe('good');
    expect(gradeForCompletion(1)).toBe('good');
    expect(gradeForCompletion(ASSISTED_THRESHOLD)).toBe('hard');
    expect(gradeForCompletion(3)).toBe('hard');
  });

  it('gives an assisted pass a shorter first interval than an unassisted one', () => {
    // The numbers are derived from FSRS-6's initial stability per grade, not configured.
    expect(firstIntervalDays(0)).toBe(3);
    expect(firstIntervalDays(1)).toBe(3);
    expect(firstIntervalDays(2)).toBe(2);
    expect(firstIntervalDays(3)).toBe(2);
    expect(firstIntervalDays(2)).toBeLessThan(firstIntervalDays(0));
  });

  it('schedules the assisted module sooner than the unassisted one on the same day', () => {
    const { nodes } = seedCompletedTopic(h.store, {
      titles: ['Unassisted lesson', 'Assisted lesson'],
      completed: 2,
      schedule: false,
    });

    const unassisted = scheduleOnCompletion(h.store, nodes[0].id, 0, NOW);
    const assisted = scheduleOnCompletion(h.store, nodes[1].id, 2, NOW);

    expect(unassisted.intervalDays).toBe(3);
    expect(assisted.intervalDays).toBe(2);
    expect(Date.parse(assisted.dueAt)).toBeLessThan(Date.parse(unassisted.dueAt));
    expect(assisted.lastAssistLevel).toBe(2);
    // WHY the difficulty check: the old scheduler's shortening washed out after one review
    // because it only moved the first interval. Grading the pass `hard` also raises initial
    // difficulty, so the assisted lesson keeps coming back sooner than the clean one.
    expect(assisted.memory.difficulty).toBeGreaterThan(unassisted.memory.difficulty);
    expect(assisted.lapses).toBe(0);
  });

  it('keeps the assisted lesson ahead of the unassisted one over a shared history', () => {
    // WHY the raised cap: both lessons reach the real 180-day cap within a few rounds of an
    // all-correct history, and once they are both clamped their intervals are equal — which
    // would hide the property under test. The lasting effect of the `hard` grade is on
    // difficulty and stability, so this measures it where the clamp is not binding. That the
    // cap itself binds is asserted in tests/review/schedule.test.ts.
    const params = scheduleParamsSchema.parse({ ...DEFAULT_SCHEDULE_PARAMS, maxIntervalDays: 36_500 });
    const { nodes } = seedCompletedTopic(h.store, {
      titles: ['Unassisted lesson', 'Assisted lesson'],
      completed: 2,
      schedule: false,
    });
    let clean = scheduleOnCompletion(h.store, nodes[0].id, 0, NOW, params);
    let helped = scheduleOnCompletion(h.store, nodes[1].id, 3, NOW, params);

    for (let i = 1; i <= 4; i += 1) {
      const day = i * 30;
      clean = recordReview(h.store, nodes[0].id, true, at(day), params);
      helped = recordReview(h.store, nodes[1].id, true, at(day), params);
      // The gap does not wash out with repetition, which is what the old scheduler's
      // one-off shorter first interval could not do.
      expect(helped.intervalDays).toBeLessThan(clean.intervalDays);
      expect(helped.memory.stability).toBeLessThan(clean.memory.stability);
      expect(helped.memory.difficulty).toBeGreaterThan(clean.memory.difficulty);
    }
  });

  it('matches the interval C1 records when a module is completed through the store', () => {
    // C1's completeModule is the path production actually takes. It used to carry its own
    // copy of the interval arithmetic; this pins it to C7's.
    const { nodes } = seedCompletedTopic(h.store, {
      titles: ['Fresh lesson'],
      completed: 0,
      schedule: false,
    });
    const assist: AssistLevel = 3;
    const stored = h.store.completeModule(nodes[0].id, {
      ...exampleEvalVerdict,
      outcome: 'assisted-pass',
      assistLevel: assist,
    });

    expect(stored.review.intervalDays).toBe(firstIntervalDays(assist));
    expect(stored.review.memory.stability).toBeGreaterThan(0);
    expect(stored.review.lapses).toBe(0);
  });
});

