// FRACTAL: implements F1 | component C9
import { sessionIdSchema } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseParam } from '@/api/validate';

export const POST = route<{ sessionId: string }>(async (_req, params) => {
  const sessionId = parseParam(sessionIdSchema, params.sessionId, 'conversation id');
  return requireStore().engine.restart(sessionId);
});
