// FRACTAL: implements F14 | component C9
import { cardIdSchema, newCardSchema } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseBody, parseParam } from '@/api/validate';
import { deleteCard, editCard } from '@/cards/library';

export const PATCH = route<{ cardId: string }>(async (req, params) => {
  const cardId = parseParam(cardIdSchema, params.cardId, 'card id');
  const body = await parseBody(req, newCardSchema);
  return editCard(requireStore().store, cardId, body);
});

export const DELETE = route<{ cardId: string }>(async (_req, params) => {
  const cardId = parseParam(cardIdSchema, params.cardId, 'card id');
  deleteCard(requireStore().store, cardId);
  return { deleted: true as const };
});
