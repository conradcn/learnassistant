// FRACTAL: implements F7 | component C9
import { z } from 'zod';
import { moduleIdSchema } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseBody, parseParam } from '@/api/validate';
import { recordReview } from '@/review/schedule';
import { toCue } from '@/review/cue';

const bodySchema = z.object({ correct: z.boolean() }).strict();

export const POST = route<{ moduleId: string }>(async (req, params) => {
  const moduleId = parseParam(moduleIdSchema, params.moduleId, 'lesson id');
  const body = await parseBody(req, bodySchema);
  // The new interval is deliberately not in the response: the learner is told when to come
  // back, not how well they did. See `docs/spaced-repetition.md` §5.
  return toCue(recordReview(requireStore().store, moduleId, body.correct));
});
