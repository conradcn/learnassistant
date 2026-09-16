// FRACTAL: implements F1 | component C9
import { z } from 'zod';
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseBody } from '@/api/validate';
import { MAX_PRACTICE_SIZE, startPractice } from '@/practice/session';

const bodySchema = z.object({ size: z.number().int().min(1).max(MAX_PRACTICE_SIZE) }).strict();

export const POST = route(async (req) => {
  const body = await parseBody(req, bodySchema);
  const svc = requireStore();
  return startPractice({ store: svc.store, practice: svc.practice }, body.size).session;
});
