// FRACTAL: implements F3 | component C5
import { z } from 'zod';
import { type EntryDecision, type ModuleGraph, type ModuleId } from '@/shapes';
import { err } from '@/core/errors';
import { effectiveGraph, unmetPrereqs } from '@/graph/availability';

export { entryDecisionSchema } from '@/shapes';
export type { EntryDecision } from '@/shapes';

export const testOutDecisionSchema = z.object({
  allowed: z.literal(true),
  highlighted: z.boolean(),
});
export type TestOutDecision = z.infer<typeof testOutDecisionSchema>;

export function canEnter(g: ModuleGraph, moduleId: ModuleId, completed: Set<ModuleId>): EntryDecision {
  const eg = effectiveGraph(g);
  const node = eg.nodesById.get(moduleId);
  if (!node) {
    throw err('not-found', { detail: 'module is not part of this topic graph' });
  }
  const unmet = unmetPrereqs(eg, moduleId, completed);
  if (unmet.length === 0) {
    return { enterable: true, advisory: null };
  }
  return {
    enterable: true,
    advisory: {
      unmetPrereqs: unmet.map((id) => ({ id, title: eg.nodesById.get(id)?.title ?? 'Another module' })),
    },
  };
}

export function canTestOut(g: ModuleGraph, moduleId: ModuleId): TestOutDecision {
  const node = g.nodes.find((n) => n.id === moduleId);
  if (!node) {
    throw err('not-found', { detail: 'module is not part of this topic graph' });
  }
  return { allowed: true, highlighted: node.testOutEligible };
}

export function hasNoOpenEntryModule(g: ModuleGraph, completed: Set<ModuleId>): boolean {
  const eg = effectiveGraph(g);
  for (const node of g.nodes) {
    if (completed.has(node.id)) continue;
    if (unmetPrereqs(eg, node.id, completed).length === 0) return false;
  }
  return g.nodes.some((n) => !completed.has(n.id));
}
