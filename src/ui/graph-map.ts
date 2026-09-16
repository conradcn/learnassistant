// FRACTAL: implements F3, F5 | component C10
import type { ModuleAvailability, ModuleGraph, ModuleId } from '@/shapes';
import { graphLayout, type GraphNodeView } from '@/ui/graph-layout';

/**
 * WHY this file exists: the three lists in C10 say what is open, but they never show that
 * one lesson grew out of another. The shape of a course — a couple of entry points, a
 * fan-out, a narrowing back down — is the one thing a picture says better than prose.
 * Everything here is pure geometry so it can be checked without a browser.
 */

/** Drawing constants, in the SVG's own units. Sizes are chosen so a title of ~40
 *  characters fits on three lines inside a box. */
export const MAP_GEOMETRY = {
  nodeWidth: 176,
  nodeHeight: 76,
  gapX: 20,
  gapY: 46,
  padding: 14,
} as const;

/** How a node is drawn: which of the three groups the learner already reads it in. */
export type MapGroup = 'done' | 'open' | 'later';

export type MapNode = {
  view: GraphNodeView;
  group: MapGroup;
  /** Centre of the box. */
  x: number;
  y: number;
};

export type MapEdge = {
  from: ModuleId;
  to: ModuleId;
  /** Cubic bezier `d`, already in SVG coordinates. */
  path: string;
  /** True when the edge ends on a lesson the learner cannot open yet. */
  pending: boolean;
};

export type GraphMap = {
  nodes: MapNode[];
  edges: MapEdge[];
  width: number;
  height: number;
  /** Layer count — 1 means a flat list of unrelated lessons, and no map is worth drawing. */
  depth: number;
};

const EMPTY: GraphMap = { nodes: [], edges: [], width: 0, height: 0, depth: 0 };

function groupOf(state: GraphNodeView['state']): MapGroup {
  if (state === 'completed' || state === 'assisted-pass' || state === 'needs-review') return 'done';
  if (state === 'available' || state === 'in-progress') return 'open';
  return 'later';
}

/**
 * One barycentre sweep: each node slides towards the average slot of the nodes it grew
 * out of. Two of these turn the naive ordinal ordering into a layout whose edges mostly
 * run straight down instead of crossing the whole picture.
 */
function reorder(layers: GraphNodeView[][], parents: Map<ModuleId, ModuleId[]>): void {
  const slot = new Map<ModuleId, number>();
  for (const layer of layers) layer.forEach((view, index) => slot.set(view.node.id, index));
  for (let depth = 1; depth < layers.length; depth += 1) {
    const layer = layers[depth] as GraphNodeView[];
    const key = new Map<ModuleId, number>();
    layer.forEach((view, index) => {
      const above = (parents.get(view.node.id) ?? [])
        .map((id) => slot.get(id))
        .filter((n): n is number => n !== undefined);
      // A node with no drawn parent keeps its own place rather than jumping to the left edge.
      key.set(view.node.id, above.length === 0 ? index : above.reduce((a, b) => a + b, 0) / above.length);
    });
    layer.sort((a, b) => {
      const delta = (key.get(a.node.id) as number) - (key.get(b.node.id) as number);
      if (delta !== 0) return delta;
      return a.node.ordinal - b.node.ordinal;
    });
    layer.forEach((view, index) => slot.set(view.node.id, index));
  }
}

function curve(from: MapNode, to: MapNode): string {
  const { nodeHeight } = MAP_GEOMETRY;
  const y1 = from.y + nodeHeight / 2;
  const y2 = to.y - nodeHeight / 2;
  const lift = Math.max(18, (y2 - y1) / 2);
  return `M ${from.x} ${y1} C ${from.x} ${y1 + lift}, ${to.x} ${y2 - lift}, ${to.x} ${y2}`;
}

/**
 * Lays the lessons out as a top-down picture: one row per prerequisite depth, rows
 * centred on each other so the course reads as a single stem rather than a left-aligned
 * ragged column.
 *
 * WHY the capstone is dropped: the topic page gives the final project its own card and
 * its own link, and a node for it here would be the same lesson twice on one screen.
 */
export function graphMap(graph: ModuleGraph, availability: ModuleAvailability[]): GraphMap {
  const layout = graphLayout(graph, availability);
  const views = [...layout.done, ...layout.open, ...layout.later].filter(
    (view) => view.node.kind !== 'capstone',
  );
  if (views.length === 0) return EMPTY;

  const drawn = new Set<ModuleId>(views.map((view) => view.node.id));
  const parents = new Map<ModuleId, ModuleId[]>();
  for (const edge of graph.edges) {
    if (!drawn.has(edge.from) || !drawn.has(edge.to)) continue;
    parents.set(edge.to, [...(parents.get(edge.to) ?? []), edge.from]);
  }

  const depth = views.reduce((max, view) => Math.max(max, view.layer), 0) + 1;
  const layers: GraphNodeView[][] = Array.from({ length: depth }, () => []);
  for (const view of views) (layers[view.layer] as GraphNodeView[]).push(view);
  for (const layer of layers) layer.sort((a, b) => a.node.ordinal - b.node.ordinal);
  reorder(layers, parents);
  reorder(layers, parents);

  const { nodeWidth, nodeHeight, gapX, gapY, padding } = MAP_GEOMETRY;
  const widest = layers.reduce((max, layer) => Math.max(max, layer.length), 1);
  const width = padding * 2 + widest * nodeWidth + (widest - 1) * gapX;
  const height = padding * 2 + depth * nodeHeight + (depth - 1) * gapY;

  const nodes: MapNode[] = [];
  layers.forEach((layer, layerIndex) => {
    const rowWidth = layer.length * nodeWidth + (layer.length - 1) * gapX;
    const left = (width - rowWidth) / 2;
    layer.forEach((view, index) => {
      nodes.push({
        view,
        group: groupOf(view.state),
        x: left + index * (nodeWidth + gapX) + nodeWidth / 2,
        y: padding + layerIndex * (nodeHeight + gapY) + nodeHeight / 2,
      });
    });
  });

  const byId = new Map<ModuleId, MapNode>(nodes.map((n) => [n.view.node.id, n]));
  const edges: MapEdge[] = [];
  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    // A prerequisite that points sideways or backwards (a detour inserted beside its
    // anchor) has no downward curve to draw; the cards still spell the relation out.
    if (from === undefined || to === undefined || to.y <= from.y) continue;
    edges.push({ from: edge.from, to: edge.to, path: curve(from, to), pending: to.group === 'later' });
  }

  return { nodes, edges, width, height, depth };
}

/** A picture of one row of unrelated boxes teaches nothing the list did not. */
export function worthDrawing(map: GraphMap): boolean {
  return map.depth >= 2 && map.nodes.length >= 3;
}

/**
 * The furthest the picture is allowed to be shrunk to fit. Below roughly this the 13.5px
 * lesson titles stop being reading size, and a map you have to lean in to read is worse
 * than one you scroll. Past the floor the panel scrolls instead of shrinking further.
 */
export const MIN_MAP_SCALE = 0.7;

/**
 * How much to scale the drawing so it sits inside the space the panel actually has.
 * Never enlarges — a three-lesson course blown up to fill a desktop reads as a diagram
 * of something much bigger than it is.
 *
 * A zero in either dimension means nothing has been measured yet (first paint, or a
 * server render), and an unmeasured box is drawn at its natural size.
 */
export function fitScale(map: GraphMap, available: { width: number; height: number }): number {
  if (map.width <= 0 || map.height <= 0) return 1;
  const byWidth = available.width > 0 ? available.width / map.width : 1;
  const byHeight = available.height > 0 ? available.height / map.height : 1;
  return Math.max(MIN_MAP_SCALE, Math.min(1, byWidth, byHeight));
}
