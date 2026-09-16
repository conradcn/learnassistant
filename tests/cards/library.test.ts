// FRACTAL: covers F14, F7 | type unit
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isoDateStringSchema, type ISODateString } from '@/shapes';
import { closeStore, openStore, type Store } from '@/store/open';
import { addCards, createDeck, deckSummaries, editCard, gradeCard, studyQueue } from '@/cards/library';

const DAY = 86_400_000;
const START = isoDateStringSchema.parse('2026-08-22T09:00:00.000Z');

function at(days: number): ISODateString {
  return isoDateStringSchema.parse(new Date(Date.parse(START) + days * DAY).toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z'));
}

describe('the flash card library', () => {
  let dataRoot: string;
  let store: Store;

  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-cards-'));
    store = openStore(dataRoot);
  });

  afterEach(() => {
    closeStore(dataRoot);
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('puts a brand new card at the front of the queue and counts it as due', () => {
    const deck = createDeck(store, { name: 'Functional groups', topicId: null }, START);
    addCards(store, deck.id, [{ front: 'Carboxyl', back: '-COOH' }], START);

    const queue = studyQueue(store, deck.id, 20, START);
    expect(queue).toHaveLength(1);
    expect(queue[0].unseen).toBe(true);

    const summary = deckSummaries(store, START).find((row) => row.deck.id === deck.id);
    expect(summary).toMatchObject({ cardCount: 1, dueCount: 1, subject: null });
  });

  it('pushes a card the learner knew out of the queue and pulls a missed one back in', () => {
    const deck = createDeck(store, { name: 'Symbols', topicId: null }, START);
    const [knew, missed] = addCards(
      store,
      deck.id,
      [
        { front: 'Amine', back: '-NH2' },
        { front: 'Ester', back: '-COO-' },
      ],
      START,
    );

    gradeCard(store, knew.id, 'knew-it', START);
    gradeCard(store, missed.id, 'missed', START);

    // Same day: neither is on offer again.
    expect(studyQueue(store, deck.id, 20, START)).toHaveLength(0);

    const knewCard = store.cards.getCard(knew.id);
    const missedCard = store.cards.getCard(missed.id);
    expect(knewCard?.intervalDays).toBeGreaterThan(missedCard?.intervalDays ?? 0);
    expect(missedCard?.lapses).toBe(1);

    // A day later only the missed one has come round again.
    const tomorrow = studyQueue(store, deck.id, 20, at(1));
    expect(tomorrow.map((card) => card.id)).toEqual([missed.id]);
    expect(tomorrow[0].unseen).toBe(false);
  });

  it('never lets the memory state cross the boundary', () => {
    const deck = createDeck(store, { name: 'Dates', topicId: null }, START);
    const [card] = addCards(store, deck.id, [{ front: '1687', back: 'Principia' }], START);
    const view = gradeCard(store, card.id, 'hard', START);
    expect(Object.keys(view).sort()).toEqual(['back', 'deckId', 'dueAt', 'front', 'id', 'unseen']);
  });

  it('leaves the schedule alone when a card is only corrected', () => {
    const deck = createDeck(store, { name: 'Prefixes', topicId: null }, START);
    const [card] = addCards(store, deck.id, [{ front: 'kilo', back: '10^2' }], START);
    gradeCard(store, card.id, 'knew-it', START);
    const scheduled = store.cards.getCard(card.id);

    editCard(store, card.id, { front: 'kilo', back: '10^3' }, at(0.5));
    const corrected = store.cards.getCard(card.id);

    expect(corrected?.back).toBe('10^3');
    expect(corrected?.dueAt).toBe(scheduled?.dueAt);
    expect(corrected?.memory).toEqual(scheduled?.memory);
  });

  it('removes a deck with its cards, and keeps other decks whole', () => {
    const doomed = createDeck(store, { name: 'Doomed', topicId: null }, START);
    const kept = createDeck(store, { name: 'Kept', topicId: null }, START);
    addCards(store, doomed.id, [{ front: 'a', back: 'b' }], START);
    addCards(store, kept.id, [{ front: 'c', back: 'd' }], START);

    store.cards.deleteDeck(doomed.id);

    expect(store.cards.getDeck(doomed.id)).toBeNull();
    expect(store.cards.listCards(doomed.id)).toEqual([]);
    expect(store.cards.listCards(kept.id)).toHaveLength(1);
  });

  it('refuses a deck with no name and a deck hung off a subject that is not there', () => {
    expect(() => createDeck(store, { name: '   ', topicId: null }, START)).toThrow();
    expect(() =>
      createDeck(store, { name: 'Orphan', topicId: '@/shapes' as never }, START),
    ).toThrow();
  });

  it('keeps cards across a close and reopen', () => {
    const deck = createDeck(store, { name: 'Groups', topicId: null }, START);
    addCards(store, deck.id, [{ front: 'Hydroxyl', back: '-OH' }], START);
    closeStore(dataRoot);

    const reopened = openStore(dataRoot);
    expect(reopened.cards.listCards(deck.id)).toHaveLength(1);
  });
});
