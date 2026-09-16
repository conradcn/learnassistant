// FRACTAL: implements F14 | component C1
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  cardDeckSchema,
  cardIdSchema,
  cardSchema,
  deckIdSchema,
  isoDateStringSchema,
  topicIdSchema,
  type Card,
  type CardDeck,
  type CardId,
  type DeckId,
  type ISODateString,
  type NewCard,
  type TopicId,
} from '@/shapes';
import { err } from '@/core/errors';

export type DeckCounts = { deckId: DeckId; cardCount: number; dueCount: number };

export type CardsRepo = {
  createDeck(input: { name: string; topicId: TopicId | null }, now: ISODateString): CardDeck;
  listDecks(): CardDeck[];
  getDeck(id: DeckId): CardDeck | null;
  renameDeck(id: DeckId, name: string, now: ISODateString): CardDeck;
  deleteDeck(id: DeckId): void;
  counts(now: ISODateString): DeckCounts[];

  addCards(deckId: DeckId, cards: readonly NewCard[], now: ISODateString): Card[];
  listCards(deckId: DeckId): Card[];
  getCard(id: CardId): Card | null;
  editCard(id: CardId, card: NewCard, now: ISODateString): Card;
  deleteCard(id: CardId): void;
  /** Cards ready to be answered, soonest-due first; `deckId` narrows it to one deck. */
  due(now: ISODateString, limit: number, deckId?: DeckId | null): Card[];
  save(card: Card): Card;
};

type DeckRow = {
  id: string;
  topic_id: string | null;
  name: string;
  created_at: string;
  updated_at: string;
};

type CardRow = {
  id: string;
  deck_id: string;
  front: string;
  back: string;
  created_at: string;
  updated_at: string;
  due_at: string;
  interval_days: number;
  lapses: number;
  stability: number;
  difficulty: number;
  reps: number;
  last_reviewed_at: string | null;
};

function newDeckId(): DeckId {
  return deckIdSchema.parse(`dk_${randomBytes(8).toString('hex')}`);
}

function newCardId(): CardId {
  return cardIdSchema.parse(`cd_${randomBytes(8).toString('hex')}`);
}

function rowToDeck(row: DeckRow): CardDeck {
  return {
    id: deckIdSchema.parse(row.id),
    topicId: row.topic_id === null ? null : topicIdSchema.parse(row.topic_id),
    name: row.name,
    createdAt: isoDateStringSchema.parse(row.created_at),
    updatedAt: isoDateStringSchema.parse(row.updated_at),
  };
}

export function rowToCard(row: CardRow): Card {
  return {
    id: cardIdSchema.parse(row.id),
    deckId: deckIdSchema.parse(row.deck_id),
    front: row.front,
    back: row.back,
    createdAt: isoDateStringSchema.parse(row.created_at),
    updatedAt: isoDateStringSchema.parse(row.updated_at),
    dueAt: isoDateStringSchema.parse(row.due_at),
    intervalDays: row.interval_days,
    lapses: row.lapses,
    memory: {
      stability: row.stability,
      difficulty: row.difficulty,
      reps: row.reps,
      lastReviewedAt: row.last_reviewed_at === null ? null : isoDateStringSchema.parse(row.last_reviewed_at),
    },
  };
}

function cardBindings(card: Card): Record<string, string | number | null> {
  return {
    id: card.id,
    deckId: card.deckId,
    front: card.front,
    back: card.back,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    dueAt: card.dueAt,
    intervalDays: card.intervalDays,
    lapses: card.lapses,
    stability: card.memory.stability,
    difficulty: card.memory.difficulty,
    reps: card.memory.reps,
    lastReviewedAt: card.memory.lastReviewedAt,
  };
}

const CARD_UPSERT_SQL = `
  INSERT INTO cards (
    id, deck_id, front, back, created_at, updated_at,
    due_at, interval_days, lapses, stability, difficulty, reps, last_reviewed_at
  )
  VALUES (
    @id, @deckId, @front, @back, @createdAt, @updatedAt,
    @dueAt, @intervalDays, @lapses, @stability, @difficulty, @reps, @lastReviewedAt
  )
  ON CONFLICT(id) DO UPDATE SET
    front = excluded.front,
    back = excluded.back,
    updated_at = excluded.updated_at,
    due_at = excluded.due_at,
    interval_days = excluded.interval_days,
    lapses = excluded.lapses,
    stability = excluded.stability,
    difficulty = excluded.difficulty,
    reps = excluded.reps,
    last_reviewed_at = excluded.last_reviewed_at
`;

export function createCardsRepo(db: Database.Database): CardsRepo {
  const insertDeck = db.prepare(`
    INSERT INTO card_decks (id, topic_id, name, created_at, updated_at)
    VALUES (@id, @topicId, @name, @createdAt, @updatedAt)
  `);
  const listDecksStmt = db.prepare('SELECT * FROM card_decks ORDER BY created_at ASC');
  const getDeckStmt = db.prepare('SELECT * FROM card_decks WHERE id = ?');
  const renameDeckStmt = db.prepare('UPDATE card_decks SET name = ?, updated_at = ? WHERE id = ?');
  // WHY the explicit card delete: `ON DELETE CASCADE` only fires with foreign keys on, and a
  // deck whose cards outlived it would leave rows nothing can reach. Deleting both in one
  // transaction holds regardless of the pragma.
  const deleteDeckCardsStmt = db.prepare('DELETE FROM cards WHERE deck_id = ?');
  const deleteDeckStmt = db.prepare('DELETE FROM card_decks WHERE id = ?');
  const countsStmt = db.prepare(`
    SELECT d.id AS deck_id,
           COUNT(c.id) AS card_count,
           COALESCE(SUM(CASE WHEN c.due_at <= @now THEN 1 ELSE 0 END), 0) AS due_count
    FROM card_decks d
    LEFT JOIN cards c ON c.deck_id = d.id
    GROUP BY d.id
  `);

  const upsertCard = db.prepare(CARD_UPSERT_SQL);
  const listCardsStmt = db.prepare('SELECT * FROM cards WHERE deck_id = ? ORDER BY created_at ASC, id ASC');
  const getCardStmt = db.prepare('SELECT * FROM cards WHERE id = ?');
  const deleteCardStmt = db.prepare('DELETE FROM cards WHERE id = ?');
  const dueAllStmt = db.prepare(
    'SELECT * FROM cards WHERE due_at <= ? ORDER BY due_at ASC, created_at ASC LIMIT ?',
  );
  const dueDeckStmt = db.prepare(
    'SELECT * FROM cards WHERE deck_id = ? AND due_at <= ? ORDER BY due_at ASC, created_at ASC LIMIT ?',
  );

  function requireDeck(id: DeckId): CardDeck {
    const row = getDeckStmt.get(id) as DeckRow | undefined;
    if (!row) {
      throw err('not-found', {
        detail: 'card deck not found',
        userMessage: 'That deck is no longer here.',
      });
    }
    return rowToDeck(row);
  }

  function writeCard(card: Card): Card {
    const parsed = cardSchema.safeParse(card);
    if (!parsed.success) {
      throw err('validation', {
        detail: 'card failed shape validation',
        userMessage: 'A card needs something on the front and something on the back.',
      });
    }
    upsertCard.run(cardBindings(parsed.data));
    return parsed.data;
  }

  return {
    createDeck(input, now): CardDeck {
      const deck: CardDeck = {
        id: newDeckId(),
        topicId: input.topicId,
        name: input.name.trim(),
        createdAt: now,
        updatedAt: now,
      };
      const parsed = cardDeckSchema.safeParse(deck);
      if (!parsed.success) {
        throw err('validation', {
          detail: 'card deck failed shape validation',
          userMessage: 'Give the deck a name and try again.',
        });
      }
      insertDeck.run({
        id: parsed.data.id,
        topicId: parsed.data.topicId,
        name: parsed.data.name,
        createdAt: parsed.data.createdAt,
        updatedAt: parsed.data.updatedAt,
      });
      return parsed.data;
    },

    listDecks(): CardDeck[] {
      return (listDecksStmt.all() as DeckRow[]).map(rowToDeck);
    },

    getDeck(id): CardDeck | null {
      const row = getDeckStmt.get(id) as DeckRow | undefined;
      return row ? rowToDeck(row) : null;
    },

    renameDeck(id, name, now): CardDeck {
      const trimmed = name.trim();
      if (trimmed.length === 0) {
        throw err('validation', {
          detail: 'empty deck name',
          userMessage: 'Give the deck a name and try again.',
        });
      }
      requireDeck(id);
      renameDeckStmt.run(trimmed, now, id);
      return requireDeck(id);
    },

    deleteDeck(id): void {
      const run = db.transaction((deckId: DeckId) => {
        deleteDeckCardsStmt.run(deckId);
        deleteDeckStmt.run(deckId);
      });
      run(id);
    },

    counts(now): DeckCounts[] {
      const rows = countsStmt.all({ now }) as { deck_id: string; card_count: number; due_count: number }[];
      return rows.map((row) => ({
        deckId: deckIdSchema.parse(row.deck_id),
        cardCount: row.card_count,
        dueCount: row.due_count,
      }));
    },

    addCards(deckId, cards, now): Card[] {
      requireDeck(deckId);
      // WHY (F14 AC): a paste is one import, so either every line lands or none does —
      // half a deck is worse than a refusal the learner can retry.
      const run = db.transaction((batch: readonly NewCard[]): Card[] =>
        batch.map((input) =>
          writeCard({
            id: newCardId(),
            deckId,
            front: input.front,
            back: input.back,
            createdAt: now,
            updatedAt: now,
            // A new card is due now: it has nothing to remember yet, so it goes to the
            // front of the queue rather than waiting on an interval it has not earned.
            dueAt: now,
            intervalDays: 0,
            lapses: 0,
            memory: { stability: 0, difficulty: 0, reps: 0, lastReviewedAt: null },
          }),
        ),
      );
      return run(cards);
    },

    listCards(deckId): Card[] {
      return (listCardsStmt.all(deckId) as CardRow[]).map(rowToCard);
    },

    getCard(id): Card | null {
      const row = getCardStmt.get(id) as CardRow | undefined;
      return row ? rowToCard(row) : null;
    },

    editCard(id, input, now): Card {
      const existing = getCardStmt.get(id) as CardRow | undefined;
      if (!existing) {
        throw err('not-found', {
          detail: 'card not found for edit',
          userMessage: 'That card is no longer here.',
        });
      }
      // WHY the schedule is untouched: fixing a typo on a card is not a retrieval, and
      // rewriting the memory state would quietly hand the learner a fresh interval every
      // time they corrected a spelling.
      return writeCard({ ...rowToCard(existing), front: input.front, back: input.back, updatedAt: now });
    },

    deleteCard(id): void {
      deleteCardStmt.run(id);
    },

    due(now, limit, deckId = null): Card[] {
      const rows =
        deckId === null
          ? (dueAllStmt.all(now, limit) as CardRow[])
          : (dueDeckStmt.all(deckId, now, limit) as CardRow[]);
      return rows.map(rowToCard);
    },

    save(card): Card {
      return writeCard(card);
    },
  };
}
