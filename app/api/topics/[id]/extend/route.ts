// FRACTAL: implements F12 | component C9
import { extensionRequestSchema, topicIdSchema } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore, pumpJobs } from '@/api/services';
import { parseBody, parseParam } from '@/api/validate';
import { err } from '@/core/errors';

export const POST = route<{ id: string }>(async (req, params) => {
  const id = parseParam(topicIdSchema, params.id, 'subject id');
  const body = await parseBody(req, extensionRequestSchema);
  if (body.topicId !== id) {
    throw err('validation', {
      detail: 'extension body names a different topic than the route',
      userMessage: 'That request was for a different subject. Reload the page and try again.',
    });
  }
  const svc = requireStore();
  const job = svc.orchestrator.requestExtension({ topicId: body.topicId, goal: body.goal });
  pumpJobs(svc);
  return job;
});
