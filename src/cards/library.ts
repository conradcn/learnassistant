// FRACTAL: implements F14, F7 | component C7
/**
 * The flash card library: the one corner of this app where knowing a thing by heart IS the
 * material. Everything else refuses to reward recall — F4 judges understanding, F7 rewords
 * rather than repeats — because a formula you can look up is not worth memorising. Names
 * are different. There is no deriving your way to "the -COOH group is called a carboxyl";
 * you either know it or you stop reading mid-sentence to find out.
 *
 * It reuses F7's memory model wholesale (`@/review/memory`) rather than growing a second
 * scheduler: a card is an item with a stability, a difficulty and a due date, which is
 * exactly what FSRS-6 schedules. What it does NOT reuse is F7's *signal* — a module's grade
 * comes from an evaluator's judgement, while a card's comes from the learner pressing one
 * of three buttons, which is the ordinary flashcard self-grade FSRS was built for.
 */
import {
  cardViewSchema,
  type Card,
  type CardDeck,
  type CardGrade,
  type CardId,
  type CardPack,
  type CardPackImport,
  type CardView,
  type DeckId,
  type DeckSummary,
  type ISODateString,
  type NewCard,
  type TopicId,
} from '@/shapes';
import { err } from '@/core/errors';
import { log } from '@/core/log';
import { nowIso } from '@/orchestrator/ids';
import type { Store } from '@/store/open';
import { firstSchedule, nextSchedule, type ReviewGrade } from '@/review/memory';

export const DEFAULT_STUDY_SIZE = 20;
export const MAX_STUDY_SIZE = 60;
export const NO_DECKS_MESSAGE =
  'No decks yet. Make one for the things you just have to know by heart — names, symbols, dates.';
export const NOTHING_DUE_MESSAGE = 'Nothing due right now. Add cards, or come back when these come round again.';

const GRADES: Record<CardGrade, ReviewGrade> = {
  missed: 'again',
  hard: 'hard',
  'knew-it': 'good',
};

export function toCardView(card: Card): CardView {
  return cardViewSchema.parse({
    id: card.id,
    deckId: card.deckId,
    front: card.front,
    back: card.back,
    dueAt: card.dueAt,
    unseen: card.memory.reps === 0,
  });
}

export function deckSummaries(store: Store, now: ISODateString = nowIso()): DeckSummary[] {
  const counts = new Map(store.cards.counts(now).map((row) => [row.deckId, row]));
  const subjects = new Map<string, string>();
  for (const row of store.topics.list()) {
    if ('degraded' in row) continue;
    subjects.set(row.id, row.subject);
  }
  return store.cards.listDecks().map((deck) => ({
    deck,
    subject: deck.topicId === null ? null : (subjects.get(deck.topicId) ?? null),
    cardCount: counts.get(deck.id)?.cardCount ?? 0,
    dueCount: counts.get(deck.id)?.dueCount ?? 0,
  }));
}

export function createDeck(
  store: Store,
  input: { name: string; topicId: TopicId | null },
  now: ISODateString = nowIso(),
): CardDeck {
  const name = input.name.trim();
  if (name.length === 0) {
    throw err('validation', {
      detail: 'deck created with an empty name',
      userMessage: 'Give the deck a name and try again.',
    });
  }
  if (input.topicId !== null && store.topics.get(input.topicId) === null) {
    throw err('not-found', {
      detail: 'deck attached to a topic that does not exist',
      userMessage: 'That subject is no longer here. Make the deck on its own instead.',
    });
  }
  const deck = store.cards.createDeck({ name, topicId: input.topicId }, now);
  log({ level: 'info', event: 'deck-created', component: 'C7', deckId: deck.id });
  return deck;
}

export function requireDeck(store: Store, deckId: DeckId): CardDeck {
  const deck = store.cards.getDeck(deckId);
  if (deck === null) {
    throw err('not-found', { detail: 'deck not found', userMessage: 'That deck is no longer here.' });
  }
  return deck;
}

export function addCards(
  store: Store,
  deckId: DeckId,
  cards: readonly NewCard[],
  now: ISODateString = nowIso(),
): CardView[] {
  requireDeck(store, deckId);
  if (cards.length === 0) {
    throw err('validation', {
      detail: 'card import with nothing in it',
      userMessage: 'Nothing there to add — a card needs a front and a back.',
    });
  }
  const written = store.cards.addCards(deckId, cards, now);
  log({ level: 'info', event: 'cards-added', component: 'C7', deckId, count: written.length });
  return written.map(toCardView);
}

/**
 * The lesson's own pack, put on the learner's shelf because they asked for it (F14 x F2).
 *
 * WHY it is one call rather than "create a deck, then add cards": the learner pressed one
 * button, and a failure halfway would leave them a deck with nothing in it and no way to
 * tell that from a deck they made themselves.
 *
 * WHY it reuses a deck of the same name on the same subject instead of making a second
 * one: the pack travels with the lesson, and a learner who opens the lesson again months
 * later and presses the button again means "make sure these are in my cards", not "give
 * me a rival copy of them". Cards whose front is already in that deck are left exactly as
 * they are — re-adding must never reset a schedule the learner has earned (F14: editing a
 * card does not touch its memory, and neither does this).
 */
export function importCardPack(
  store: Store,
  pack: CardPack,
  topicId: TopicId | null,
  now: ISODateString = nowIso(),
): CardPackImport {
  const name = pack.name.trim();
  const existing = findPackDeck(store, name, topicId);
  const deck = existing ?? createDeck(store, { name, topicId }, now);
  const present = new Set(store.cards.listCards(deck.id).map((card) => cardKey(card.front)));
  const fresh = pack.cards.filter((card) => !present.has(cardKey(card.front)));
  const added = fresh.length === 0 ? [] : addCards(store, deck.id, fresh, now);
  log({
    level: 'info',
    event: 'card-pack-added',
    component: 'C7',
    deckId: deck.id,
    count: added.length,
    alreadyThere: pack.cards.length - added.length,
  });
  return { deck, added, alreadyThere: pack.cards.length - added.length };
}

/** The deck a pack lands in, if the learner has taken it before. Same name, same subject. */
export function findPackDeck(store: Store, name: string, topicId: TopicId | null): CardDeck | null {
  const wanted = name.trim().toLowerCase();
  return (
    store.cards.listDecks().find((deck) => deck.topicId === topicId && deck.name.trim().toLowerCase() === wanted) ??
    null
  );
}

// Fronts are compared the way a learner would read them: same words, same card.
function cardKey(front: string): string {
  return front.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function listCards(store: Store, deckId: DeckId): CardView[] {
  requireDeck(store, deckId);
  return store.cards.listCards(deckId).map(toCardView);
}

export function editCard(store: Store, cardId: CardId, input: NewCard, now: ISODateString = nowIso()): CardView {
  return toCardView(store.cards.editCard(cardId, input, now));
}

export function deleteCard(store: Store, cardId: CardId): void {
  store.cards.deleteCard(cardId);
}

/**
 * The cards to put in front of the learner right now: everything due, soonest first, which
 * places a card added a minute ago (due immediately, never answered) ahead of one that came
 * round again today.
 *
 * WHY it is a queue and never a gate — same rule as F7: a deck left unstudied blocks nothing
 * and nags nowhere. It is a list of cards on offer.
 */
export function studyQueue(
  store: Store,
  deckId: DeckId | null = null,
  size: number = DEFAULT_STUDY_SIZE,
  now: ISODateString = nowIso(),
): CardView[] {
  if (deckId !== null) requireDeck(store, deckId);
  const bounded = Math.min(MAX_STUDY_SIZE, Math.max(1, Math.floor(size)));
  return store.cards.due(now, bounded, deckId).map(toCardView);
}

/**
 * One answered card. `missed` is a lapse and pulls the card back in, `hard` keeps it close,
 * `knew-it` pushes it out — the same three grades F7 maps its evaluator verdicts onto, so a
 * card and a lesson age by the same arithmetic.
 */
export function gradeCard(
  store: Store,
  cardId: CardId,
  grade: CardGrade,
  now: ISODateString = nowIso(),
): CardView {
  const card = store.cards.getCard(cardId);
  if (card === null) {
    throw err('not-found', { detail: 'card not found', userMessage: 'That card is no longer here.' });
  }
  const reviewGrade = GRADES[grade];
  // A card the learner has never answered has no memory to advance — its first answer is
  // the encoding event, exactly as a module's first pass is.
  const scheduled =
    card.memory.reps === 0
      ? firstSchedule(reviewGrade, now)
      : nextSchedule(
          { memory: card.memory, dueAt: card.dueAt, intervalDays: card.intervalDays, lapses: card.lapses },
          reviewGrade,
          now,
        );
  const saved = store.cards.save({
    ...card,
    dueAt: scheduled.dueAt,
    intervalDays: scheduled.intervalDays,
    lapses: card.lapses + (scheduled.lapsed ? 1 : 0),
    memory: scheduled.memory,
  });
  log({ level: 'info', event: 'card-graded', component: 'C7', cardId, grade });
  return toCardView(saved);
}
