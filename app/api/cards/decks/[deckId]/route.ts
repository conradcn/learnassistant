// FRACTAL: implements F14 | component C9
import { z } from 'zod';
import { deckIdSchema, MAX_DECK_NAME_CHARS } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseBody, parseParam } from '@/api/validate';
import { listCards, requireDeck } from '@/cards/library';
import { nowIso } from '@/orchestrator/ids';

const bodySchema = z.object({ name: z.string().min(1).max(MAX_DECK_NAME_CHARS) }).strict();

export const GET = route<{ deckId: string }>(async (_req, params) => {
  const deckId = parseParam(deckIdSchema, params.deckId, 'deck id');
  const store = requireStore().store;
  return { deck: requireDeck(store, deckId), cards: listCards(store, deckId) };
});

export const PATCH = route<{ deckId: string }>(async (req, params) => {
  const deckId = parseParam(deckIdSchema, params.deckId, 'deck id');
  const body = await parseBody(req, bodySchema);
  const store = requireStore().store;
  requireDeck(store, deckId);
  return store.cards.renameDeck(deckId, body.name, nowIso());
});

export const DELETE = route<{ deckId: string }>(async (_req, params) => {
  const deckId = parseParam(deckIdSchema, params.deckId, 'deck id');
  const store = requireStore().store;
  requireDeck(store, deckId);
  store.cards.deleteDeck(deckId);
  return { deleted: true as const };
});
