// FRACTAL: implements F1 | component C9
import { evalTargetSchema, type EvalTarget } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseBody } from '@/api/validate';
import type { EvalKind } from '@/eval/session';

function kindOf(target: EvalTarget): EvalKind {
  return target.kind === 'test-out' ? 'test-out' : target.kind;
}

// WHY: a read of the conversation that is already there. It never creates one, so the
// page can restore a transcript on every load without spending a decision.
export const POST = route(async (req) => {
  const target = await parseBody(req, evalTargetSchema);
  return { session: requireStore().engine.peek(kindOf(target), target) };
});
