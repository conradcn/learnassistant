// FRACTAL: implements F2 | component C4
import { z } from 'zod';
import {
  type GraphValidation,
  type ModuleGraph,
  type ModuleId,
  type ModuleNode,
  type PrereqEdge,
  type Topic,
  type TopicNote,
} from '@/shapes';
import { log } from '@/core/log';
import { nowIso } from '@/orchestrator/ids';
import { authoringBrief } from '@/orchestrator/author-module';
import { loadMaterial } from '@/source/material';
import { READ_ONLY_TOOLS, dispatchSession, type OrchestratorDeps } from '@/orchestrator/session';

export const REVIEW_TIMEOUT_MS = 10 * 60 * 1000;

/** WHY exported: the note offers to run the check again, so whatever runs it again has to
 *  be able to take the note back down. A copy of the string in the caller would drift. */
export const REVIEW_UNAVAILABLE_NOTE =
  'The consistency check could not run this time. Your lessons are all still usable — you can run the check again from this page.';

export type { GraphValidation } from '@/shapes';

export const reviewOutputSchema = z.union([
  z.object({
    kind: z.string().optional(),
    message: z.string().min(1).max(2000),
    affectedModules: z.array(z.string()).max(64).optional(),
    createdAt: z.string().optional(),
  }),
  z.object({
    issues: z
      .array(
        z.object({
          message: z.string().min(1).max(2000),
          affectedModules: z.array(z.string()).max(64).optional(),
        }),
      )
      .max(64),
  }),
]);

function ordinalOf(graph: ModuleGraph, id: ModuleId): number {
  return graph.nodes.find((n) => n.id === id)?.ordinal ?? Number.MAX_SAFE_INTEGER;
}

function titleOf(graph: ModuleGraph, id: ModuleId): string {
  return graph.nodes.find((n) => n.id === id)?.title ?? 'an unknown lesson';
}

export function findCycle(nodes: ModuleNode[], edges: PrereqEdge[]): ModuleId[] | null {
  const outgoing = new Map<ModuleId, ModuleId[]>();
  for (const n of nodes) outgoing.set(n.id, []);
  for (const e of edges) {
    if (!outgoing.has(e.from) || !outgoing.has(e.to)) continue;
    (outgoing.get(e.from) as ModuleId[]).push(e.to);
  }
  const state = new Map<ModuleId, 0 | 1 | 2>();
  const path: ModuleId[] = [];

  const visit = (id: ModuleId): ModuleId[] | null => {
    state.set(id, 1);
    path.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const s = state.get(next) ?? 0;
      if (s === 1) return path.slice(path.indexOf(next));
      if (s === 0) {
        const found = visit(next);
        if (found) return found;
      }
    }
    path.pop();
    state.set(id, 2);
    return null;
  };

  for (const n of nodes) {
    if ((state.get(n.id) ?? 0) === 0) {
      const found = visit(n.id);
      if (found) return found;
    }
  }
  return null;
}

// WHY: "lowest confidence" is made concrete and deterministic — an edge that
// points backwards through the outline is the least believable prerequisite,
// then the widest ordinal jump, then id order so two runs agree.
export function lowestConfidenceEdge(graph: ModuleGraph, cycle: ModuleId[]): PrereqEdge {
  const cycleEdges: PrereqEdge[] = [];
  for (let i = 0; i < cycle.length; i += 1) {
    cycleEdges.push({ from: cycle[i], to: cycle[(i + 1) % cycle.length] });
  }
  const scored = cycleEdges.map((e) => {
    const fromOrd = ordinalOf(graph, e.from);
    const toOrd = ordinalOf(graph, e.to);
    return { edge: e, backwards: fromOrd > toOrd ? 1 : 0, gap: Math.abs(fromOrd - toOrd) };
  });
  scored.sort((a, b) => {
    if (a.backwards !== b.backwards) return b.backwards - a.backwards;
    if (a.gap !== b.gap) return b.gap - a.gap;
    return `${a.edge.from}${a.edge.to}` < `${b.edge.from}${b.edge.to}` ? -1 : 1;
  });
  return scored[0].edge;
}

export function entryModulesOf(nodes: ModuleNode[], edges: PrereqEdge[]): ModuleId[] {
  const hasPrereq = new Set(edges.map((e) => e.to));
  return nodes.filter((n) => !hasPrereq.has(n.id)).map((n) => n.id);
}

export function unreachableFrom(nodes: ModuleNode[], edges: PrereqEdge[], entry: ModuleId[]): ModuleId[] {
  const outgoing = new Map<ModuleId, ModuleId[]>();
  for (const n of nodes) outgoing.set(n.id, []);
  for (const e of edges) {
    if (!outgoing.has(e.from) || !outgoing.has(e.to)) continue;
    (outgoing.get(e.from) as ModuleId[]).push(e.to);
  }
  const seen = new Set<ModuleId>(entry);
  const stack = [...entry];
  while (stack.length > 0) {
    const current = stack.pop() as ModuleId;
    for (const next of outgoing.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return nodes.filter((n) => !seen.has(n.id)).map((n) => n.id);
}

export type ValidatedGraph = { graph: ModuleGraph; validation: GraphValidation };

// WHY: a cyclic graph is never silently accepted — the cycle is broken by
// dropping exactly one named edge and a `graph-defect` note says which.
export function validateGraph(graph: ModuleGraph): ValidatedGraph {
  const issues: TopicNote[] = [];
  let edges = [...graph.edges];
  let wasCyclic = false;
  // WHY: reachability is judged against the outline as proposed, so an island
  // of lessons nobody can arrive at is named even when breaking its internal
  // loop later happens to open one of them.
  const proposedEntry = entryModulesOf(graph.nodes, graph.edges);
  const proposedReachFrom = proposedEntry.length > 0 ? proposedEntry : graph.nodes.map((n) => n.id);
  const unreachable = unreachableFrom(graph.nodes, graph.edges, proposedReachFrom);

  for (let guard = 0; guard < graph.nodes.length + graph.edges.length + 1; guard += 1) {
    const cycle = findCycle(graph.nodes, edges);
    if (cycle === null) break;
    wasCyclic = true;
    const dropped = lowestConfidenceEdge(graph, cycle);
    edges = edges.filter((e) => !(e.from === dropped.from && e.to === dropped.to));
    issues.push({
      kind: 'graph-defect',
      message: `The lessons looped back on themselves, so we removed the link that said "${titleOf(graph, dropped.to)}" needs "${titleOf(graph, dropped.from)}" first.`,
      affectedModules: [dropped.from, dropped.to],
      createdAt: nowIso(),
    });
  }

  const entryModules = entryModulesOf(graph.nodes, edges);
  if (entryModules.length === 0 && graph.nodes.length > 0) {
    issues.push({
      kind: 'graph-defect',
      message: 'Every lesson listed another lesson as a prerequisite, so none of them could be a starting point. They are all open to you instead.',
      affectedModules: graph.nodes.map((n) => n.id),
      createdAt: nowIso(),
    });
  }
  const effectiveEntry = entryModules.length > 0 ? entryModules : graph.nodes.map((n) => n.id);
  if (unreachable.length > 0) {
    issues.push({
      kind: 'graph-defect',
      message: `${unreachable.length === 1 ? 'One lesson' : `${unreachable.length} lessons`} could not be reached from any starting lesson: ${unreachable.map((id) => `"${titleOf(graph, id)}"`).join(', ')}. They are open to you directly.`,
      affectedModules: unreachable,
      createdAt: nowIso(),
    });
  }

  const finalEntry = unreachable.length > 0 ? [...new Set([...effectiveEntry, ...unreachable])] : effectiveEntry;
  return {
    graph: { ...graph, edges, entryModules: finalEntry },
    validation: { acyclic: !wasCyclic, entryModules: finalEntry, unreachable, issues },
  };
}

// WHY: cross-topic candidates are surfaced rather than silently ignored — they
// become F9 synthesis prompts.
export function crossTopicCandidates(topic: Topic, otherTopics: Topic[], graph: ModuleGraph): TopicNote[] {
  const terms = new Set(
    graph.nodes
      .flatMap((n) => n.title.toLowerCase().split(/[^a-z0-9]+/))
      .filter((w) => w.length > 4),
  );
  const notes: TopicNote[] = [];
  for (const other of otherTopics) {
    if (other.id === topic.id) continue;
    const otherWords = other.subject.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 4);
    const overlap = otherWords.filter((w) => terms.has(w));
    if (overlap.length === 0) continue;
    notes.push({
      kind: 'cross-topic',
      message: `This shares ground with your topic "${other.subject}" (${overlap.slice(0, 3).join(', ')}). Worth connecting the two.`,
      affectedModules: [],
      createdAt: nowIso(),
    });
  }
  return notes;
}

/**
 * `ran` says a session was attempted and so has been paid for. `answered` says the
 * reviewer actually came back with a verdict about these lessons — a review that failed
 * has still run, but it knows nothing, and callers that would act on its findings must
 * not treat its silence as "no problems found".
 */
export type ReviewOutcome = { notes: TopicNote[]; ran: boolean; answered: boolean };

// WHY: the review runs exactly once per generation, after every module has
// finished; the engine holds the counter, this function performs the one run.
export async function runDiscontinuityReview(
  deps: OrchestratorDeps,
  topic: Topic,
  drivingQuestion: string,
  graph: ModuleGraph,
  workspaceModuleId: ModuleId,
  signal: AbortSignal,
): Promise<ReviewOutcome> {
  const anchor = graph.nodes.find((n) => n.id === workspaceModuleId) ?? graph.nodes[0];
  if (anchor === undefined) return { notes: [], ran: false, answered: false };

  const material = loadMaterial(deps.store, deps.dataRoot, topic.id);
  const brief = authoringBrief(
    topic,
    drivingQuestion,
    graph,
    anchor,
    [
      'Read every lesson in this topic and report where goals, prerequisites or terminology do not line up across lesson boundaries.',
      // The check the material buys: a course written from a syllabus that then calls the
      // same idea three names across three lessons has a discontinuity the learner will
      // meet the moment they open their own book beside it.
      ...(material === null
        ? []
        : ['Report any lesson that names an idea differently from the material the learner brought.']),
      ...graph.nodes.map((n) => `${n.ordinal}. ${n.title}`),
    ],
    material,
  );

  const outcome = await dispatchSession(deps, {
    kind: 'discontinuity-review',
    topicId: topic.id,
    workspaceModuleId: anchor.id,
    brief,
    outputSchema: reviewOutputSchema,
    timeoutMs: REVIEW_TIMEOUT_MS,
    maxTurns: 30,
    allowedTools: READ_ONLY_TOOLS,
    signal,
  });

  if (!outcome.ok) {
    log({ level: 'warn', event: 'orchestrator-review-failed', component: 'C4', topicId: topic.id, code: outcome.code });
    return {
      ran: true,
      answered: false,
      notes: [
        {
          kind: 'discontinuity',
          message: REVIEW_UNAVAILABLE_NOTE,
          affectedModules: [],
          createdAt: nowIso(),
        },
      ],
    };
  }

  const parsed = reviewOutputSchema.safeParse(outcome.output);
  if (!parsed.success) return { ran: true, answered: false, notes: [] };

  const known = new Set<ModuleId>(graph.nodes.map((n) => n.id));
  const toNote = (message: string, affected: string[] | undefined): TopicNote => ({
    kind: 'discontinuity',
    message,
    // WHY: module ids in model output are untrusted; only ids already in this
    // topic survive.
    affectedModules: (affected ?? []).filter((id): id is ModuleId => known.has(id as ModuleId)),
    createdAt: nowIso(),
  });

  const notes =
    'issues' in parsed.data
      ? parsed.data.issues.map((i) => toNote(i.message, i.affectedModules))
      : [toNote(parsed.data.message, parsed.data.affectedModules)];

  return { ran: true, answered: true, notes };
}
