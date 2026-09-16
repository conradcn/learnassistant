// FRACTAL: covers F7 | type unit
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isoDateStringSchema, type ModuleId } from '@/shapes';
import { canEnter } from '@/graph/entry';
import { availability, completedSet } from '@/graph/availability';
import { due, dueCount, queueHeader, reviewQueue } from '@/review/queue';
import { at, bootC7, NOW, seedCompletedTopic, type C7Harness } from '@/review/harness.testing';

let h: C7Harness;

beforeEach(() => {
  h = bootC7();
});

afterEach(() => {
  h.teardown();
});

describe('F7 the review queue is a queue, not a gate', () => {
  it('leaves every other action reachable while reviews are overdue', () => {
    const { topic, nodes } = seedCompletedTopic(h.store, {
      titles: ['One', 'Two', 'Three'],
      completed: 2,
    });
    const overdue = due(h.store, at(365), 10);
    expect(overdue.length).toBeGreaterThan(0);

    const graph = h.store.modules.graph(topic.id);
    const decision = canEnter(graph, nodes[2].id, completedSet(graph));
    expect(decision.enterable).toBe(true);
    expect(decision.advisory).toBeNull();

    const stillAvailable = availability(graph, completedSet(graph)).filter((a) => a.state === 'available');
    expect(stillAvailable.length).toBeGreaterThan(0);
    expect(dueCount(h.store, at(365))).toBeGreaterThan(0);

    const queue = reviewQueue(h.store, at(365), 3);
    expect(queue.blocksOtherWork).toBe(false);
    expect(queue.cards.every((c) => c.moduleTitle.length > 0)).toBe(true);
  });

  it('shows only today batch when the backlog exceeds the daily cap, and names the cap', () => {
    seedCompletedTopic(h.store, {
      titles: ['One', 'Two', 'Three', 'Four', 'Five', 'Six'],
      completed: 6,
    });

    const queue = reviewQueue(h.store, at(365), 3);

    expect(queue.dueTotal).toBe(6);
    expect(queue.shown).toBe(3);
    expect(queue.cards).toHaveLength(3);
    expect(queue.header).toContain('6 due');
    expect(queue.header).toContain("today's 3");
    expect(queue.header).toContain('daily limit 3');
    expect(dueCount(h.store, at(365))).toBe(6);
    expect(due(h.store, at(365), 3)).toHaveLength(3);
  });

  it('drops a review that points at a deleted lesson instead of blocking the queue', () => {
    const { nodes } = seedCompletedTopic(h.store, { titles: ['One'], completed: 1 });
    const ghost = 'm_deadbeefdeadbeef' as ModuleId;
    h.store.reviews.upsert({
      moduleId: ghost,
      dueAt: isoDateStringSchema.parse('2020-01-01T00:00:00.000Z'),
      intervalDays: 1,
      memory: { stability: 3, difficulty: 2.1181, reps: 1, lastReviewedAt: null },
      lapses: 0,
      lastAssistLevel: 0,
      flaggedNeedsReview: false,
    });

    const queue = reviewQueue(h.store, at(365));

    expect(queue.droppedCount).toBe(1);
    expect(queue.cards.map((c) => c.moduleId)).toEqual([nodes[0].id]);
    expect(due(h.store, at(365), 5).map((i) => i.moduleId)).not.toContain(ghost);
  });

  it('says nothing is due rather than going silent when the queue is empty', () => {
    seedCompletedTopic(h.store, { titles: ['One'], completed: 1 });
    const queue = reviewQueue(h.store, NOW);
    expect(queue.cards).toHaveLength(0);
    expect(queue.dueTotal).toBe(0);
    expect(queue.header).toBe('Nothing is due for review right now.');
    expect(queueHeader(1, 1, 3)).toBe('1 review is ready when you are.');
    expect(queueHeader(2, 2, 3)).toBe('2 reviews are ready when you are.');
  });
});
