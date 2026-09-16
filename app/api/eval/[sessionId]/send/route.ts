// FRACTAL: implements F1 | component C9
import { z } from 'zod';
import { learnerMessageSchema, selfAssessmentSchema, sessionIdSchema } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore, pumpJobs } from '@/api/services';
import { parseBody, parseParam, parseValue } from '@/api/validate';

const bodySchema = z
  .object({
    text: z.string().min(1),
    selfAssessment: selfAssessmentSchema.nullable(),
  })
  .strict();

export const POST = route<{ sessionId: string }>(async (req, params) => {
  const sessionId = parseParam(sessionIdSchema, params.sessionId, 'conversation id');
  const body = await parseBody(req, bodySchema);
  const message = parseValue(learnerMessageSchema, { text: body.text, selfAssessment: body.selfAssessment }, 'message');
  const svc = requireStore();
  const result = await svc.engine.send(sessionId, message);
  // WHY: a failed turn can queue a remedial lesson; it needs the same pump as any
  // other enqueue, or the detour never runs.
  pumpJobs(svc);
  return result;
});
