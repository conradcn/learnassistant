// FRACTAL: implements F14 | component C9
import { z } from 'zod';
import { MAX_DECK_NAME_CHARS, topicIdSchema } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseBody } from '@/api/validate';
import { createDeck, deckSummaries } from '@/cards/library';

const bodySchema = z
  .object({
    name: z.string().min(1).max(MAX_DECK_NAME_CHARS),
    topicId: topicIdSchema.nullable().default(null),
  })
  .strict();

export const GET = route(async () => deckSummaries(requireStore().store));

export const POST = route(async (req) => {
  const body = await parseBody(req, bodySchema);
  return createDeck(requireStore().store, { name: body.name, topicId: body.topicId });
});
