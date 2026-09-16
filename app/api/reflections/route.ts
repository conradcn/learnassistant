// FRACTAL: implements F1 | component C9
import { newReflectionSchema, topicIdSchema } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseBody } from '@/api/validate';
import { saveReflection } from '@/reflect/journal';
import { parseParam } from '@/api/validate';

export const POST = route(async (req) => saveReflection(requireStore().store, await parseBody(req, newReflectionSchema)));

export const GET = route(async (req) => {
  const topicId = new URL(req.url).searchParams.get('topicId');
  const store = requireStore().store;
  if (topicId === null) return store.reflections.listAll();
  return store.reflections.listByTopic(parseParam(topicIdSchema, topicId, 'subject id'));
});
