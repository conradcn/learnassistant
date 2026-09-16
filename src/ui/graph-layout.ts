// FRACTAL: implements F3, F5 | component C10
import type { ModuleAvailability, ModuleGraph, ModuleId, ModuleNode, ModuleState } from '@/shapes';
import { contentDigest } from '@/ui/sanitize';

export type GraphNodeView = {
  node: ModuleNode;
  state: ModuleState;
  layer: number;
  prereqTitles: string[];
  unmetPrereqTitles: string[];
};

export type GraphLayout = {
  done: GraphNodeView[];
  open: GraphNodeView[];
  later: GraphNodeView[];
  isOpenChoice: boolean;
  nodeCount: number;
};

const DONE_STATES: ReadonlySet<ModuleState> = new Set<ModuleState>([
  'completed',
  'assisted-pass',
  'needs-review',
]);

const OPEN_STATES: ReadonlySet<ModuleState> = new Set<ModuleState>(['available', 'in-progress']);

/** Hoisted so the sort never allocates a comparator per render (H11). */
function byLayerThenOrdinal(a: GraphNodeView, b: GraphNodeView): number {
  if (a.layer !== b.layer) return a.layer - b.layer;
  if (a.node.ordinal !== b.node.ordinal) return a.node.ordinal - b.node.ordinal;
  return a.node.title.localeCompare(b.node.title);
}

/**
 * WHY: C5 owns the same edge walk, but its module reaches the filesystem logger and so
 * cannot be bundled into the browser. This is the read-only view half of it: prerequisite
 * lists and depth, nothing that decides availability (the server already did that).
 */
function prereqIndex(graph: ModuleGraph): Map<ModuleId, ModuleId[]> {
  const known = new Set<ModuleId>(graph.nodes.map((n) => n.id));
  const prereqs = new Map<ModuleId, ModuleId[]>();
  for (const node of graph.nodes) prereqs.set(node.id, []);
  for (const edge of graph.edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    (prereqs.get(edge.to) as ModuleId[]).push(edge.from);
  }
  return prereqs;
}

function layerIndex(graph: ModuleGraph, prereqs: Map<ModuleId, ModuleId[]>): Map<ModuleId, number> {
  const layers = new Map<ModuleId, number>();
  const visiting = new Set<ModuleId>();
  const depthOf = (id: ModuleId): number => {
    const cached = layers.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let depth = 0;
    for (const parent of prereqs.get(id) ?? []) {
      depth = Math.max(depth, depthOf(parent) + 1);
    }
    visiting.delete(id);
    layers.set(id, depth);
    return depth;
  };
  for (const node of graph.nodes) depthOf(node.id);
  return layers;
}

function signature(graph: ModuleGraph, availability: ModuleAvailability[]): string {
  const nodes = graph.nodes.map((n) => `${n.id}:${n.state}:${n.ordinal}:${n.title}`).join('|');
  const edges = graph.edges.map((e) => `${e.from}>${e.to}`).join('|');
  const avail = availability.map((a) => `${a.moduleId}:${a.state}:${a.unmetPrereqs.join(',')}`).join('|');
  return contentDigest(`${graph.topicId}#${nodes}#${edges}#${avail}`);
}

const layoutCache = new Map<string, GraphLayout>();
const LAYOUT_MEMO_LIMIT = 32;

function computeLayout(graph: ModuleGraph, availability: ModuleAvailability[]): GraphLayout {
  const prereqs = prereqIndex(graph);
  const layers = layerIndex(graph, prereqs);
  const titles = new Map<ModuleId, string>(graph.nodes.map((n) => [n.id, n.title]));
  const availabilityById = new Map<ModuleId, ModuleAvailability>(
    availability.map((a) => [a.moduleId, a]),
  );

  const done: GraphNodeView[] = [];
  const open: GraphNodeView[] = [];
  const later: GraphNodeView[] = [];

  for (const node of graph.nodes) {
    const known = availabilityById.get(node.id);
    const state = known === undefined ? node.state : known.state;
    const view: GraphNodeView = {
      node,
      state,
      layer: layers.get(node.id) ?? 0,
      prereqTitles: (prereqs.get(node.id) ?? []).map((id) => titles.get(id) ?? 'another lesson'),
      unmetPrereqTitles: (known?.unmetPrereqs ?? []).map((id) => titles.get(id) ?? 'another lesson'),
    };
    if (DONE_STATES.has(state)) done.push(view);
    else if (OPEN_STATES.has(state)) open.push(view);
    else later.push(view);
  }

  done.sort(byLayerThenOrdinal);
  open.sort(byLayerThenOrdinal);
  later.sort(byLayerThenOrdinal);

  return { done, open, later, isOpenChoice: open.length >= 2, nodeCount: graph.nodes.length };
}

// WHY this counter is exported: "the memo works" was previously checked by comparing
// how long a warm render took against a cold one, which two near-identical React renders
// decide by luck — the check passed whether or not the memo existed. Counting the walks
// is the thing the claim is actually about, and it cannot pass by accident.
let walks = 0;

/** How many times the edge walk has actually run since the memo was last reset. */
export function graphLayoutWalks(): number {
  return walks;
}

/** Memoized per graph content so a re-render never re-walks the edges (H11). */
export function graphLayout(graph: ModuleGraph, availability: ModuleAvailability[]): GraphLayout {
  const key = signature(graph, availability);
  const hit = layoutCache.get(key);
  if (hit !== undefined) return hit;
  walks += 1;
  const layout = computeLayout(graph, availability);
  layoutCache.set(key, layout);
  if (layoutCache.size > LAYOUT_MEMO_LIMIT) {
    const oldest = layoutCache.keys().next();
    if (oldest.done !== true) layoutCache.delete(oldest.value);
  }
  return layout;
}

export function resetGraphLayoutMemo(): void {
  layoutCache.clear();
  walks = 0;
}

export function prereqSentence(view: GraphNodeView): string {
  if (view.prereqTitles.length === 0) return 'A place you can start from.';
  return `Builds on ${view.prereqTitles.join(' and ')}.`;
}

export function stillToComeSentence(view: GraphNodeView): string {
  if (view.unmetPrereqTitles.length === 0) return 'Suggested a little later on.';
  return `Suggested after ${view.unmetPrereqTitles.join(' and ')}.`;
}

export function capstoneNode(graph: ModuleGraph): ModuleNode | null {
  return graph.nodes.find((n) => n.kind === 'capstone') ?? null;
}
