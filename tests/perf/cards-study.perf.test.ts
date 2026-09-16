// FRACTAL: covers F14 | type unit
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NewCard } from '@/shapes';
import { addCards, createDeck, deckSummaries, MAX_STUDY_SIZE, studyQueue } from '@/cards/library';
import { at, bootC7, NOW, type C7Harness } from '@/review/harness.testing';

const DECKS = 20;
const CARDS_PER_DECK = 500;
const SAMPLES = 25;
const P95_BUDGET_MS = 300;

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

describe('F14 study queue at declared scale', () => {
  let h: C7Harness;

  beforeAll(() => {
    h = bootC7();
    for (let d = 0; d < DECKS; d += 1) {
      const deck = createDeck(h.store, { name: `Deck ${d}`, topicId: null }, NOW);
      const batch: NewCard[] = [];
      for (let c = 0; c < CARDS_PER_DECK; c += 1) {
        batch.push({ front: `Term ${d}-${c}`, back: `Meaning ${d}-${c}` });
      }
      addCards(h.store, deck.id, batch, NOW);
    }
  });

  afterAll(() => {
    h.teardown();
  });

  it(`opens a study round in under ${P95_BUDGET_MS}ms p95 across ${DECKS * CARDS_PER_DECK} cards`, () => {
    const samples: number[] = [];
    let lastSize = 0;
    for (let i = 0; i < SAMPLES; i += 1) {
      const started = performance.now();
      const queue = studyQueue(h.store, null, MAX_STUDY_SIZE, at(1));
      samples.push(performance.now() - started);
      lastSize = queue.length;
    }
    expect(lastSize).toBe(MAX_STUDY_SIZE);
    const sorted = [...samples].sort((a, b) => a - b);
    expect(percentile(sorted, 0.95)).toBeLessThan(P95_BUDGET_MS);
  });

  it('counts every deck in one pass rather than one query per deck', () => {
    const started = performance.now();
    const summaries = deckSummaries(h.store, at(1));
    expect(performance.now() - started).toBeLessThan(P95_BUDGET_MS);
    expect(summaries).toHaveLength(DECKS);
    expect(summaries[0].cardCount).toBe(CARDS_PER_DECK);
  });
});
