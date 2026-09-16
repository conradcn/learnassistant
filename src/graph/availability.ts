// FRACTAL: implements F3, F5 | component C5
import {
  type ModuleAvailability,
  type ModuleGraph,
  type ModuleId,
  type ModuleNode,
  type ModuleState,
  type PrereqEdge,
} from '@/shapes';
import { log } from '@/core/log';
import { isPassedState } from '@/graph/passed';

export { moduleAvailabilitySchema } from '@/shapes';
export type { ModuleAvailability } from '@/shapes';

export type GraphDefects = {
  backEdges: PrereqEdge[];
  missingPrereqEdges: PrereqEdge[];
};

export type EffectiveGraph = {
  nodesById: Map<ModuleId, ModuleNode>;
  prereqsOf: Map<ModuleId, ModuleId[]>;
  dependentsOf: Map<ModuleId, ModuleId[]>;
  defects: GraphDefects;
};

export { isPassedState } from '@/graph/passed';

export function completedSet(g: ModuleGraph): Set<ModuleId> {
  const out = new Set<ModuleId>();
  for (const node of g.nodes) {
    if (isPassedState(node.state)) out.add(node.id);
  }
  return out;
}

function detectBackEdges(
  nodes: ModuleNode[],
  outgoing: Map<ModuleId, ModuleId[]>,
): Set<string> {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<ModuleId, number>();
  const backEdges = new Set<string>();
  for (const node of nodes) colour.set(node.id, WHITE);

  for (const root of nodes) {
    if (colour.get(root.id) !== WHITE) continue;
    const stack: { id: ModuleId; cursor: number }[] = [{ id: root.id, cursor: 0 }];
    colour.set(root.id, GREY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const next = outgoing.get(frame.id) ?? [];
      if (frame.cursor >= next.length) {
        colour.set(frame.id, BLACK);
        stack.pop();
        continue;
      }
      const child = next[frame.cursor];
      frame.cursor += 1;
      const childColour = colour.get(child);
      if (childColour === undefined) continue;
      if (childColour === GREY) {
        backEdges.add(`${frame.id}->${child}`);
        continue;
      }
      if (childColour === WHITE) {
        colour.set(child, GREY);
        stack.push({ id: child, cursor: 0 });
      }
    }
  }
  return backEdges;
}

export function effectiveGraph(g: ModuleGraph): EffectiveGraph {
  const nodesById = new Map<ModuleId, ModuleNode>();
  for (const node of g.nodes) nodesById.set(node.id, node);

  const missingPrereqEdges: PrereqEdge[] = [];
  const presentEdges: PrereqEdge[] = [];
  for (const edge of g.edges) {
    if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) {
      missingPrereqEdges.push(edge);
      continue;
    }
    presentEdges.push(edge);
  }

  const outgoing = new Map<ModuleId, ModuleId[]>();
  for (const node of g.nodes) outgoing.set(node.id, []);
  for (const edge of presentEdges) {
    (outgoing.get(edge.from) as ModuleId[]).push(edge.to);
  }

  const backEdgeKeys = detectBackEdges(g.nodes, outgoing);
  const backEdges: PrereqEdge[] = [];
  const prereqsOf = new Map<ModuleId, ModuleId[]>();
  const dependentsOf = new Map<ModuleId, ModuleId[]>();
  for (const node of g.nodes) {
    prereqsOf.set(node.id, []);
    dependentsOf.set(node.id, []);
  }
  for (const edge of presentEdges) {
    if (backEdgeKeys.has(`${edge.from}->${edge.to}`)) {
      backEdges.push(edge);
      continue;
    }
    (prereqsOf.get(edge.to) as ModuleId[]).push(edge.from);
    (dependentsOf.get(edge.from) as ModuleId[]).push(edge.to);
  }

  // WHY: edge order is whatever the store happened to return, so prereq and
  // dependent lists are re-ordered into the graph's own node order — every
  // consumer (the entry advisory, the unlock list) then reads the same order on
  // every run instead of one that shifts with generated ids.
  const nodeIndex = new Map<ModuleId, number>();
  g.nodes.forEach((node, i) => nodeIndex.set(node.id, i));
  const byNodeOrder = (a: ModuleId, b: ModuleId): number =>
    (nodeIndex.get(a) ?? 0) - (nodeIndex.get(b) ?? 0);
  for (const list of prereqsOf.values()) list.sort(byNodeOrder);
  for (const list of dependentsOf.values()) list.sort(byNodeOrder);

  const defects: GraphDefects = { backEdges, missingPrereqEdges };
  if (backEdges.length > 0 || missingPrereqEdges.length > 0) {
    log({
      level: 'warn',
      event: 'graph-defect',
      component: 'C5',
      topicId: g.topicId,
      backEdgeCount: backEdges.length,
      missingPrereqEdgeCount: missingPrereqEdges.length,
    });
  }

  return { nodesById, prereqsOf, dependentsOf, defects };
}

export function graphDefects(g: ModuleGraph): GraphDefects {
  return effectiveGraph(g).defects;
}

export function unmetPrereqs(
  eg: EffectiveGraph,
  moduleId: ModuleId,
  completed: Set<ModuleId>,
): ModuleId[] {
  const prereqs = eg.prereqsOf.get(moduleId) ?? [];
  const out: ModuleId[] = [];
  for (const prereq of prereqs) {
    if (!completed.has(prereq)) out.push(prereq);
  }
  return out;
}

function derivedState(node: ModuleNode, completed: Set<ModuleId>, unmetCount: number): ModuleState {
  if (completed.has(node.id)) {
    return isPassedState(node.state) ? node.state : 'completed';
  }
  if (node.state === 'needs-review' || node.state === 'in-progress') return node.state;
  return unmetCount === 0 ? 'available' : 'not-yet-recommended';
}

export function availability(g: ModuleGraph, completed: Set<ModuleId>): ModuleAvailability[] {
  const eg = effectiveGraph(g);
  const out: ModuleAvailability[] = [];
  for (const node of g.nodes) {
    const unmet = unmetPrereqs(eg, node.id, completed);
    out.push({
      moduleId: node.id,
      state: derivedState(node, completed, unmet.length),
      unmetPrereqs: unmet,
    });
  }
  return out;
}

export function unlockedBy(g: ModuleGraph, moduleId: ModuleId, completed: Set<ModuleId>): ModuleId[] {
  const eg = effectiveGraph(g);
  if (!eg.nodesById.has(moduleId)) return [];
  const withModule = new Set<ModuleId>(completed);
  withModule.add(moduleId);
  const out: ModuleId[] = [];
  for (const dependent of eg.dependentsOf.get(moduleId) ?? []) {
    if (withModule.has(dependent)) continue;
    if (unmetPrereqs(eg, dependent, completed).length === 0) continue;
    if (unmetPrereqs(eg, dependent, withModule).length === 0) out.push(dependent);
  }
  return out;
}
