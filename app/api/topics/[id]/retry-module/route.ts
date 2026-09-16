// FRACTAL: implements F1 | component C9
import { z } from 'zod';
import { moduleIdSchema, topicIdSchema } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore, pumpJobs } from '@/api/services';
import { parseBody, parseParam } from '@/api/validate';
import { moduleDir } from '@/api/confine';

const bodySchema = z.object({ moduleId: moduleIdSchema }).strict();

export const POST = route<{ id: string }>(async (req, params) => {
  const id = parseParam(topicIdSchema, params.id, 'subject id');
  const body = await parseBody(req, bodySchema);
  const svc = requireStore();
  moduleDir(svc.dataRoot, id, body.moduleId);
  const job = svc.orchestrator.retryModule(id, body.moduleId);
  pumpJobs(svc);
  return job;
});
