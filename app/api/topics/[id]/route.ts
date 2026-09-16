// FRACTAL: implements F1 | component C9
import { topicIdSchema } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseParam } from '@/api/validate';
import { topicDetail } from '@/api/views';
import { deleteTopicEverywhere } from '@/orchestrator/delete-topic';

type Params = { id: string };

export const GET = route<Params>(async (_req, params) =>
  topicDetail(requireStore(), parseParam(topicIdSchema, params.id, 'subject id')),
);

export const DELETE = route<Params>(async (_req, params) => {
  const id = parseParam(topicIdSchema, params.id, 'subject id');
  const svc = requireStore();
  // WHY this is not three calls here: the order matters and is explained where it lives.
  deleteTopicEverywhere(svc, id);
  return { deleted: true as const };
});
