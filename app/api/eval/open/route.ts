// FRACTAL: implements F1 | component C9
import { evalTargetSchema, type EvalTarget } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseBody } from '@/api/validate';
import type { EvalKind } from '@/eval/session';

function kindOf(target: EvalTarget): EvalKind {
  return target.kind === 'test-out' ? 'test-out' : target.kind;
}

export const POST = route(async (req) => {
  const target = await parseBody(req, evalTargetSchema);
  return requireStore().engine.open(kindOf(target), target);
});
