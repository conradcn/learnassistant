// FRACTAL: implements F1, F4 | component C9
import { sessionIdSchema } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore, pumpJobs } from '@/api/services';
import { parseParam } from '@/api/validate';

// WHY: reopening a conversation whose last word is the learner's is a request for the
// reply that was owed and never arrived, not a new message. It carries no body for that
// reason — the message is already in the transcript. `null` means nothing was owed.
export const POST = route<{ sessionId: string }>(async (_req, params) => {
  const sessionId = parseParam(sessionIdSchema, params.sessionId, 'conversation id');
  const svc = requireStore();
  const result = await svc.engine.continueTurn(sessionId);
  // WHY the same pump as send: a resumed turn can fail and queue a remedial lesson too.
  pumpJobs(svc);
  return result;
});
