// FRACTAL: implements F1 | component C9
import { moduleIdSchema } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseParam } from '@/api/validate';
import { moduleDetail } from '@/api/views';

export const GET = route<{ id: string }>(async (_req, params) =>
  moduleDetail(requireStore(), parseParam(moduleIdSchema, params.id, 'lesson id')),
);
