// FRACTAL: implements F12 | component C5
import { type InsertionCheck, type ModuleGraph, type ModuleId, type ModuleNode, type PrereqEdge } from '@/shapes';

export { insertionCheckSchema } from '@/shapes';
export type { InsertionCheck } from '@/shapes';

function titleOf(g: ModuleGraph, id: ModuleId): string {
  return g.nodes.find((n) => n.id === id)?.title ?? 'another module';
}

function createsCycle(nodeIds: Set<ModuleId>, edges: PrereqEdge[], start: ModuleId): boolean {
  const outgoing = new Map<ModuleId, ModuleId[]>();
  for (const id of nodeIds) outgoing.set(id, []);
  for (const edge of edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    (outgoing.get(edge.from) as ModuleId[]).push(edge.to);
  }
  const seen = new Set<ModuleId>();
  const stack: ModuleId[] = [start];
  let first = true;
  while (stack.length > 0) {
    const current = stack.pop() as ModuleId;
    if (!first && current === start) return true;
    first = false;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of outgoing.get(current) ?? []) stack.push(next);
  }
  return false;
}

export function validateInsertion(g: ModuleGraph, node: ModuleNode, edges: PrereqEdge[]): InsertionCheck {
  if (node.topicId !== g.topicId) {
    return {
      ok: false,
      reason: 'unknown-anchor',
      detail: 'That new module belongs to a different topic, so it cannot be added here.',
    };
  }
  const existingIds = new Set<ModuleId>(g.nodes.map((n) => n.id));
  if (existingIds.has(node.id)) {
    return {
      ok: false,
      reason: 'unknown-anchor',
      detail: 'That module is already part of this topic.',
    };
  }

  for (const edge of edges) {
    if (edge.from !== node.id && edge.to !== node.id) {
      return {
        ok: false,
        reason: 'unknown-anchor',
        detail: 'One of the new prerequisite links does not touch the new module.',
      };
    }
    const other = edge.from === node.id ? edge.to : edge.from;
    if (!existingIds.has(other)) {
      return {
        ok: false,
        reason: 'unknown-anchor',
        detail: 'One of the new prerequisite links points at a module that is not in this topic.',
      };
    }
  }

  const allIds = new Set<ModuleId>(existingIds);
  allIds.add(node.id);
  if (createsCycle(allIds, [...g.edges, ...edges], node.id)) {
    return {
      ok: false,
      reason: 'would-create-cycle',
      detail: 'Adding that module would make its prerequisites loop back on themselves.',
    };
  }

  const outgoingFromNew = edges.filter((e) => e.from === node.id);
  if (outgoingFromNew.length > 0) {
    return {
      ok: false,
      reason: 'prereq-of-existing',
      detail: `A detour may not become a prerequisite of "${titleOf(g, outgoingFromNew[0].to)}".`,
    };
  }

  return { ok: true };
}
