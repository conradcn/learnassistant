// FRACTAL: implements F1 | component C9
import { z } from 'zod';
import { sessionIdSchema } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseBody, parseParam } from '@/api/validate';
import { answerPractice } from '@/practice/session';

const bodySchema = z.object({ index: z.number().int().min(0), correct: z.boolean() }).strict();

export const POST = route<{ sessionId: string }>(async (req, params) => {
  const sessionId = parseParam(sessionIdSchema, params.sessionId, 'practice id');
  const body = await parseBody(req, bodySchema);
  const svc = requireStore();
  return answerPractice({ store: svc.store, practice: svc.practice }, sessionId, body.index, body.correct);
});
