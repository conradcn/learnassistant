// FRACTAL: implements F14, F7 | component C9
import { z } from 'zod';
import { cardGradeSchema, cardIdSchema } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseBody, parseParam } from '@/api/validate';
import { gradeCard } from '@/cards/library';

const bodySchema = z.object({ grade: cardGradeSchema }).strict();

export const POST = route<{ cardId: string }>(async (req, params) => {
  const cardId = parseParam(cardIdSchema, params.cardId, 'card id');
  const body = await parseBody(req, bodySchema);
  return gradeCard(requireStore().store, cardId, body.grade);
});
