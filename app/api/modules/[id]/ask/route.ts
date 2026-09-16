// FRACTAL: implements F3 | component C9
import { z } from 'zod';
import { moduleIdSchema } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseBody, parseParam } from '@/api/validate';
import { askAboutLesson, MAX_QUESTION_CHARS } from '@/eval/ask';

const bodySchema = z.object({ question: z.string().min(1).max(MAX_QUESTION_CHARS) }).strict();

export const POST = route<{ id: string }>(async (req, params) => {
  const moduleId = parseParam(moduleIdSchema, params.id, 'lesson id');
  const body = await parseBody(req, bodySchema);
  const svc = requireStore();
  return askAboutLesson(svc, moduleId, body.question);
});
