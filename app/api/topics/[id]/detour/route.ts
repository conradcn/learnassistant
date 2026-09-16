// FRACTAL: implements F1 | component C9
import { detourRequestSchema, topicIdSchema } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore, pumpJobs } from '@/api/services';
import { parseBody, parseParam } from '@/api/validate';
import { err } from '@/core/errors';

export const POST = route<{ id: string }>(async (req, params) => {
  const id = parseParam(topicIdSchema, params.id, 'subject id');
  const body = await parseBody(req, detourRequestSchema);
  if (body.topicId !== id) {
    throw err('validation', {
      detail: 'detour body names a different topic than the route',
      userMessage: 'That detour was for a different subject. Reload the page and try again.',
    });
  }
  const svc = requireStore();
  const job = svc.orchestrator.requestDetour({
    topicId: body.topicId,
    anchorModuleId: body.anchorModuleId,
    question: body.question,
  });
  pumpJobs(svc);
  return job;
});
