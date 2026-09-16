// FRACTAL: implements F14 | component C9
import { z } from 'zod';
import { deckIdSchema } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseQuery } from '@/api/validate';
import { MAX_STUDY_SIZE, studyQueue } from '@/cards/library';

const querySchema = z
  .object({
    deckId: deckIdSchema.optional(),
    size: z.coerce.number().int().min(1).max(MAX_STUDY_SIZE).optional(),
  })
  .strict();

export const GET = route(async (req) => {
  const query = parseQuery(req, querySchema);
  return studyQueue(requireStore().store, query.deckId ?? null, query.size);
});
