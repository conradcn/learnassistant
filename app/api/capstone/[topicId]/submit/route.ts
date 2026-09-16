// FRACTAL: implements F1 | component C9
import { z } from 'zod';
import { topicIdSchema } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseBody, parseParam } from '@/api/validate';

const bodySchema = z.object({ artifact: z.string().min(1).max(200_000) }).strict();

export const POST = route<{ topicId: string }>(async (req, params) => {
  const topicId = parseParam(topicIdSchema, params.topicId, 'subject id');
  const body = await parseBody(req, bodySchema);
  return requireStore().engine.submitCapstone(topicId, body.artifact);
});
