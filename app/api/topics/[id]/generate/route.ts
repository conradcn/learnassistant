// FRACTAL: implements F1 | component C9
import { topicIdSchema } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore, pumpJobs } from '@/api/services';
import { parseParam } from '@/api/validate';
import { startGeneration } from '@/api/views';

export const POST = route<{ id: string }>(async (_req, params) => {
  const id = parseParam(topicIdSchema, params.id, 'subject id');
  const svc = requireStore();
  const job = startGeneration(svc, id);
  pumpJobs(svc);
  return job;
});
