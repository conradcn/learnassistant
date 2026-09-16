// FRACTAL: covers F7 | type unit
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reviewItemSchema, type ModuleId, type ReviewItem } from '@/shapes';
import { AppError } from '@/core/errors';
import {
  DEFAULT_SCHEDULE_PARAMS,
  advanced,
  dueAtFrom,
  recordGradedReview,
  recordReview,
  scheduleOnCompletion,
} from '@/review/schedule';
import { due } from '@/review/queue';
import { at, bootC7, NOW, seedCompletedTopic, type C7Harness } from '@/review/harness.testing';

let h: C7Harness;

beforeEach(() => {
  h = bootC7();
});

afterEach(() => {
  h.teardown();
});

describe('F7 review schedule', () => {
  it('extends the interval when a review is answered correctly', () => {
    const { nodes } = seedCompletedTopic(h.store, { completed: 1 });
    const first = scheduleOnCompletion(h.store, nodes[0].id, 0, NOW);
    expect(first.intervalDays).toBe(3);

    const second = recordReview(h.store, nodes[0].id, true, at(3));

    expect(second.intervalDays).toBeGreaterThan(first.intervalDays);
    expect(second.memory.stability).toBeGreaterThan(first.memory.stability);
    expect(second.dueAt).toBe(dueAtFrom(at(3), second.intervalDays));
    expect(second.flaggedNeedsReview).toBe(false);
    expect(reviewItemSchema.safeParse(second).success).toBe(true);
    expect(h.store.reviews.get(nodes[0].id)).toEqual(second);
  });

  it('pulls the interval back and flags the lesson when a review is missed', () => {
    const { topic, nodes } = seedCompletedTopic(h.store, { completed: 1 });
    scheduleOnCompletion(h.store, nodes[0].id, 0, NOW);
    const held = recordReview(h.store, nodes[0].id, true, at(3));

    const missed = recordReview(h.store, nodes[0].id, false, at(11));

    expect(missed.intervalDays).toBeLessThan(held.intervalDays);
    expect(missed.memory.stability).toBeLessThan(held.memory.stability);
    // A miss makes the item harder, which is what keeps later intervals shorter.
    expect(missed.memory.difficulty).toBeGreaterThan(held.memory.difficulty);
    expect(missed.lapses).toBe(1);
    expect(missed.flaggedNeedsReview).toBe(true);
    const node = h.store.modules.graph(topic.id).nodes.find((n) => n.id === nodes[0].id);
    expect(node?.state).toBe('needs-review');
  });

  it('keeps difficulty inside its bounds however many times a review is missed', () => {
    const { nodes } = seedCompletedTopic(h.store, { completed: 1 });
    scheduleOnCompletion(h.store, nodes[0].id, 0, NOW);
    let item: ReviewItem | null = null;
    for (let i = 0; i < 40; i += 1) {
      item = recordReview(h.store, nodes[0].id, false, at(i + 1));
    }
    expect(item?.memory.difficulty).toBeLessThanOrEqual(10);
    expect(item?.memory.difficulty).toBeGreaterThanOrEqual(1);
    expect(item?.intervalDays).toBeGreaterThanOrEqual(DEFAULT_SCHEDULE_PARAMS.minIntervalDays);
  });

  it('lets a repeatedly-missed lesson recover, rather than punishing it forever', () => {
    // WHY this test exists: the old scheduler decremented `ease` on every miss and never
    // restored it, so an item missed early was permanently penalised — "ease hell". FSRS
    // mean-reverts difficulty, so sustained success walks it back.
    const { nodes } = seedCompletedTopic(h.store, { completed: 1 });
    scheduleOnCompletion(h.store, nodes[0].id, 0, NOW);
    for (let i = 0; i < 5; i += 1) recordReview(h.store, nodes[0].id, false, at(i + 1));
    const punished = h.store.reviews.get(nodes[0].id);
    expect(punished).not.toBeNull();

    let day = 10;
    let recovered = punished as ReviewItem;
    for (let i = 0; i < 20; i += 1) {
      recovered = recordReview(h.store, nodes[0].id, true, at(day));
      day += recovered.intervalDays;
    }

    expect(recovered.memory.difficulty).toBeLessThan((punished as ReviewItem).memory.difficulty);
    expect(recovered.intervalDays).toBeGreaterThan((punished as ReviewItem).intervalDays);
  });

  it('caps the interval but never graduates a module out of scheduling', () => {
    const { nodes } = seedCompletedTopic(h.store, { completed: 1 });
    scheduleOnCompletion(h.store, nodes[0].id, 0, NOW);
    let item = h.store.reviews.get(nodes[0].id);
    expect(item).not.toBeNull();
    for (let i = 0; i < 20; i += 1) {
      item = recordReview(h.store, nodes[0].id, true, at(i * 200));
    }
    expect(item?.intervalDays).toBe(DEFAULT_SCHEDULE_PARAMS.maxIntervalDays);

    const atCap = recordReview(h.store, nodes[0].id, true, NOW);
    expect(atCap.intervalDays).toBe(DEFAULT_SCHEDULE_PARAMS.maxIntervalDays);
    expect(Date.parse(atCap.dueAt)).toBeGreaterThan(Date.parse(NOW));

    const resurfaced = due(h.store, at(181), 10);
    expect(resurfaced.map((r) => r.moduleId)).toContain(nodes[0].id);
  });

  it('stores due instants absolutely, so a clock moved backwards just leaves items due', () => {
    const { nodes } = seedCompletedTopic(h.store, { completed: 1 });
    const item = scheduleOnCompletion(h.store, nodes[0].id, 0, at(365));
    expect(item.dueAt).toBe(dueAtFrom(at(365), 3));

    const backwards = due(h.store, NOW, 10);
    expect(backwards).toHaveLength(0);

    const later = due(h.store, at(400), 10);
    expect(later.map((r) => r.moduleId)).toEqual([nodes[0].id]);
    expect(h.store.reviews.get(nodes[0].id)?.dueAt).toBe(item.dueAt);
  });

  it('refuses to record a review for a module that was never scheduled', () => {
    expect(() => recordReview(h.store, 'm_99999999999999zz' as ModuleId, true, NOW)).toThrowError(AppError);
    try {
      recordReview(h.store, 'm_99999999999999zz' as ModuleId, true, NOW);
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('not-found');
      expect((e as AppError).message).not.toMatch(/sql|sqlite|\.ts/i);
    }
  });

  it('advances a pure item without touching the store', () => {
    const item: ReviewItem = {
      moduleId: 'm_11111111111111aa' as ModuleId,
      dueAt: NOW,
      intervalDays: 10,
      lapses: 1,
      lastAssistLevel: 1,
      flaggedNeedsReview: true,
      memory: { stability: 10, difficulty: 5, reps: 3, lastReviewedAt: at(-10) },
    };

    const next = advanced(item, 'good', NOW);

    expect(next.intervalDays).toBeGreaterThan(item.intervalDays);
    expect(item.intervalDays).toBe(10);
    expect(item.memory.stability).toBe(10);
    expect(next.flaggedNeedsReview).toBe(false);
  });

  it('is deterministic: the same history replayed twice lands on the same schedule', () => {
    // F7 requires scheduling that a test can pin down without a provider call. FSRS's
    // interval fuzz is off for exactly this reason.
    const { nodes } = seedCompletedTopic(h.store, { titles: ['A', 'B'], completed: 2, schedule: false });
    const history: boolean[] = [true, true, false, true, true, false, true];

    const run = (moduleId: ModuleId): ReviewItem => {
      let item = scheduleOnCompletion(h.store, moduleId, 0, NOW);
      let day = item.intervalDays;
      for (const correct of history) {
        item = recordReview(h.store, moduleId, correct, at(day));
        day += item.intervalDays;
      }
      return item;
    };

    const first = run(nodes[0].id);
    const second = run(nodes[1].id);

    expect(second.intervalDays).toBe(first.intervalDays);
    expect(second.memory.stability).toBe(first.memory.stability);
    expect(second.memory.difficulty).toBe(first.memory.difficulty);
    expect(second.lapses).toBe(first.lapses);
  });

  it('treats a review passed with heavy help as harder than a clean one', () => {
    const { nodes } = seedCompletedTopic(h.store, {
      titles: ['Clean', 'Helped'],
      completed: 2,
      schedule: false,
    });
    scheduleOnCompletion(h.store, nodes[0].id, 0, NOW);
    scheduleOnCompletion(h.store, nodes[1].id, 0, NOW);

    const clean = recordGradedReview(h.store, nodes[0].id, 'good', at(3));
    const helped = recordGradedReview(h.store, nodes[1].id, 'hard', at(3));

    expect(helped.intervalDays).toBeLessThan(clean.intervalDays);
    expect(helped.memory.difficulty).toBeGreaterThan(clean.memory.difficulty);
    // An assisted pass is still a pass: no lapse, no re-flag.
    expect(helped.lapses).toBe(0);
    expect(helped.flaggedNeedsReview).toBe(false);
  });
});
