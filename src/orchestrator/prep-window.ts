// FRACTAL: implements F2 | component C4
import type { ModuleGraph, ModuleNode } from '@/shapes';
import { isPassedState } from '@/graph/passed';

/**
 * How many prerequisite layers of unwritten lessons are prepared in one pass: the layer
 * the learner can start now, and the layer immediately behind it.
 */
export const PREP_LOOKAHEAD_DEPTH = 2;

/**
 * The ceiling on one pass, in lessons. Depth alone does not bound a wide graph — the
 * default outline shape is one entry module with everything else hanging off it, so the
 * whole course sits at depth 1 and "two layers" is the entire degree.
 *
 * WHY it is a swarm's width and not a handful: the next pass is only picked up by the
 * five-minute sweep (`PREP_SWEEP_INTERVAL_MS`), and a pass in flight blocks another for the
 * same subject, so a window narrower than the session pool leaves most of the pool idle
 * between passes — the batch finishes, and nothing is written for whatever is left of the
 * five minutes. This is sized to cover a whole ordinary topic in one pass, which is what
 * keeps every permit busy.
 */
export const MAX_PREP_MODULES = 24;

/**
 * WHY: the plan may legitimately be a degree's worth of lessons, but preparing all of it
 * before the first one is read spends every session up front on material the learner may
 * never reach, and makes the authorisation the learner is shown enormous. What is bounded
 * is the lookahead, not the course: each pass writes the lessons that are next in the
 * prerequisite graph, and the subject page then offers the next pass with its own cost.
 *
 * Depth is measured over the UNWRITTEN nodes only, so an already-written prerequisite does
 * not push its successor out of the window — as lessons land, the window slides forward.
 *
 * WHY availability comes before depth: depth 0 is "no UNWRITTEN lesson stands in front of
 * it", which is a much larger set than "the learner may start it today" — a lesson whose
 * prerequisites are written but not yet passed is depth 0 too. Ordering by ordinal inside
 * that set let a locked lesson early in the course take a slot from an unlocked one late
 * in it, and once MAX_PREP_MODULES was full, the available-but-unwritten lessons that
 * caused the pass to be queued were exactly the ones it did not write. The sweep then
 * found them still unwritten, queued another pass, and got the same window back: the
 * subject burned ten sessions every five minutes and the learner's next lesson stayed
 * empty. Lessons the learner can start now are written first; the rest of the window is
 * the lookahead it always was.
 */
export function prepWindow(graph: ModuleGraph): ModuleNode[] {
  // WHY this and not C5's `availability`: this function is on the subject page's render
  // path and is called twice per view (once for the window, once for the deferred count),
  // and `availability` builds the whole effective graph — a cycle-detecting DFS, two sorted
  // adjacency maps and a defect log — every time. Doing that here cost enough per render to
  // put the read routes over their event-loop budget. The one fact needed is "every
  // prerequisite has been passed", which is one pass over the edges. Ordering is all this
  // decides; C5 remains the only answer to what the learner may actually open.
  const passed = new Set<string>();
  for (const n of graph.nodes) if (isPassedState(n.state)) passed.add(n.id);
  const blocked = new Set<string>();
  for (const edge of graph.edges) if (!passed.has(edge.from)) blocked.add(edge.to);
  const startableNow = (n: ModuleNode): boolean => !blocked.has(n.id) && !passed.has(n.id);
  const unwritten = graph.nodes.filter((n) => n.kind !== 'capstone' && n.content === null);
  const pending = new Set(unwritten.map((n) => n.id));
  const prereqs = new Map<string, string[]>();
  for (const node of unwritten) prereqs.set(node.id, []);
  for (const edge of graph.edges) {
    if (!pending.has(edge.to) || !pending.has(edge.from)) continue;
    prereqs.get(edge.to)?.push(edge.from);
  }

  // Depth 0 is "nothing unwritten stands in front of it" — the lessons that become
  // available first. A cycle cannot survive validateGraph, and the `visiting` guard means
  // one that did would be treated as depth 0 rather than recursing forever.
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  function depthOf(id: string): number {
    const known = depths.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const before = prereqs.get(id) ?? [];
    const depth = before.length === 0 ? 0 : Math.max(...before.map(depthOf)) + 1;
    visiting.delete(id);
    depths.set(id, depth);
    return depth;
  }

  return unwritten
    .filter((n) => startableNow(n) || depthOf(n.id) < PREP_LOOKAHEAD_DEPTH)
    .sort(
      (a, b) =>
        Number(startableNow(b)) - Number(startableNow(a)) ||
        depthOf(a.id) - depthOf(b.id) ||
        a.ordinal - b.ordinal,
    )
    .slice(0, MAX_PREP_MODULES);
}

/** Every lesson the plan names that nobody has written yet. The capstone has its own action. */
export function unwrittenModules(graph: ModuleGraph): ModuleNode[] {
  return graph.nodes.filter((n) => n.kind !== 'capstone' && n.content === null);
}

/** The lessons this pass is deliberately leaving for a later one. */
export function deferredCount(graph: ModuleGraph): number {
  return unwrittenModules(graph).length - prepWindow(graph).length;
}
