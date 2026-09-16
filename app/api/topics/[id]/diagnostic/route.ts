// FRACTAL: implements F1 | component C9
import { diagnosticTurnRequestSchema, topicIdSchema } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseBody, parseParam } from '@/api/validate';
import { diagnosticTurn } from '@/eval/diagnostic';

export const POST = route<{ id: string }>(async (req, params) => {
  const id = parseParam(topicIdSchema, params.id, 'subject id');
  const body = await parseBody(req, diagnosticTurnRequestSchema);
  const svc = requireStore();
  return diagnosticTurn(svc, id, body);
});
