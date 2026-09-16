// FRACTAL: covers F14, F2 | type unit
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isoDateStringSchema, type CardPack, type ISODateString, type Topic } from '@/shapes';
import { closeStore, openStore, type Store } from '@/store/open';
import { addCards, findPackDeck, gradeCard, importCardPack, listCards, studyQueue } from '@/cards/library';

const START: ISODateString = isoDateStringSchema.parse('2026-08-22T09:00:00.000Z');
const LATER: ISODateString = isoDateStringSchema.parse('2026-08-24T09:00:00.000Z');

const pack: CardPack = {
  name: 'Functional groups',
  why: 'Nothing derives the names.',
  cards: [
    { front: 'Carboxyl', back: 'minus COOH' },
    { front: 'Amine', back: 'minus NH2' },
  ],
};

describe('the pack of cards a lesson wrote', () => {
  let dataRoot: string;
  let store: Store;
  let topic: Topic;

  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-pack-'));
    store = openStore(dataRoot);
    topic = store.topics.create({ subject: 'Organic chemistry', level: 'beginner', purpose: 'exam', diagnostic: null });
  });

  afterEach(() => {
    closeStore(dataRoot);
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('lands as a deck of its own on the learner\'s shelf, attached to the subject', () => {
    const result = importCardPack(store, pack, topic.id, START);

    expect(result.deck.name).toBe('Functional groups');
    expect(result.deck.topicId).toBe(topic.id);
    expect(result.added).toHaveLength(2);
    expect(result.alreadyThere).toBe(0);
    expect(studyQueue(store, result.deck.id, 20, START)).toHaveLength(2);
  });

  it('is nothing until the learner asks for it', () => {
    // Nobody has pressed the button, so there is no deck to find.
    expect(findPackDeck(store, pack.name, topic.id)).toBeNull();
  });

  it('adds nothing the second time and leaves the schedule the learner earned alone', () => {
    const first = importCardPack(store, pack, topic.id, START);
    const carboxyl = first.added.find((card) => card.front === 'Carboxyl');
    if (carboxyl === undefined) throw new Error('the pack did not add its first card');
    const graded = gradeCard(store, carboxyl.id, 'knew-it', START);

    const again = importCardPack(store, pack, topic.id, LATER);

    expect(again.deck.id).toBe(first.deck.id);
    expect(again.added).toHaveLength(0);
    expect(again.alreadyThere).toBe(2);
    expect(listCards(store, first.deck.id)).toHaveLength(2);
    const after = listCards(store, first.deck.id).find((card) => card.id === carboxyl.id);
    expect(after?.dueAt).toBe(graded.dueAt);
    expect(after?.unseen).toBe(false);
  });

  it('adds only the cards a rewritten lesson brought that were not there already', () => {
    const first = importCardPack(store, pack, topic.id, START);
    const grown: CardPack = {
      ...pack,
      cards: [...pack.cards, { front: 'Hydroxyl', back: 'minus OH' }],
    };

    const again = importCardPack(store, grown, topic.id, LATER);

    expect(again.added.map((card) => card.front)).toEqual(['Hydroxyl']);
    expect(again.alreadyThere).toBe(2);
    expect(listCards(store, first.deck.id)).toHaveLength(3);
  });

  it('does not mistake a deck the learner made for the lesson\'s, on a different subject', () => {
    const other = store.topics.create({ subject: 'Biology', level: 'beginner', purpose: 'exam', diagnostic: null });
    const mine = importCardPack(store, pack, other.id, START);
    addCards(store, mine.deck.id, [{ front: 'Carboxyl', back: 'my own note' }], START);

    const lesson = importCardPack(store, pack, topic.id, START);

    expect(lesson.deck.id).not.toBe(mine.deck.id);
    expect(lesson.added).toHaveLength(2);
  });
});
