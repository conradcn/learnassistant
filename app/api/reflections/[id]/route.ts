// FRACTAL: implements F1 | component C9
import { z } from 'zod';
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseBody, parseParam } from '@/api/validate';
import { editReflection } from '@/reflect/journal';

const reflectionIdSchema = z.string().regex(/^r_[0-9a-f]{16}$/);
const bodySchema = z.object({ text: z.string().min(1).max(20_000) }).strict();

export const PATCH = route<{ id: string }>(async (req, params) => {
  const id = parseParam(reflectionIdSchema, params.id, 'note id');
  const body = await parseBody(req, bodySchema);
  return editReflection(requireStore().store, id, body.text);
});
