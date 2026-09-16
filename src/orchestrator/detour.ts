// FRACTAL: implements F12 | component C4
import type { ModuleGraph, ModuleId, ModuleNode, PrereqEdge, TopicStatus } from '@/shapes';
import { err } from '@/core/errors';
import { validateInsertion } from '@/graph/insertion';
import type { InsertionCheck } from '@/shapes';
import { newModuleId } from '@/orchestrator/ids';
import type { DetourRequest } from '@/orchestrator/plan';

export type DetourPlan = { node: ModuleNode; edges: PrereqEdge[]; objectives: string[] };

export const DETOUR_BLOCKED_MESSAGE =
  'One of the lessons in this topic still needs attention. Finish or retry that lesson first, then you can add a side trip.';

// WHY (F12 path): a detour is declined while the topic is `needs-attention`,
// and the reason is stated rather than the request being queued silently.
export function detourAllowedForStatus(status: TopicStatus): boolean {
  return status !== 'needs-attention' && status !== 'queued' && status !== 'generating';
}

export function nextOrdinal(graph: ModuleGraph): number {
  // WHY (F12 AC): a detour is appended past every existing ordinal, so no
  // existing module is ever renumbered.
  return graph.nodes.reduce((max, n) => Math.max(max, n.ordinal), 0) + 1;
}

export function planDetour(graph: ModuleGraph, req: DetourRequest): DetourPlan {
  const anchor = graph.nodes.find((n) => n.id === req.anchorModuleId);
  if (anchor === undefined) {
    throw err('not-found', {
      detail: 'detour anchor module is not part of this topic',
      userMessage: 'We could not find the lesson you wanted to branch off from.',
    });
  }
  const node: ModuleNode = {
    id: newModuleId(),
    topicId: graph.topicId,
    title: `Side trip: ${req.question.trim().slice(0, 160)}`,
    ordinal: nextOrdinal(graph),
    kind: 'detour',
    testOutEligible: false,
    estimatedMinutes: 20,
    state: 'available',
    content: null,
  };
  // WHY (F12 AC): the ONLY edge is anchor -> detour. A detour never gains an
  // outgoing edge, so it can never become a prerequisite of an existing module.
  const edges: PrereqEdge[] = [{ from: anchor.id, to: node.id }];
  return {
    node,
    edges,
    objectives: [
      `Answer the learner's own question: ${req.question.trim()}`,
      `Build on "${anchor.title}" without repeating it.`,
    ],
  };
}

export function checkDetourInsertion(graph: ModuleGraph, plan: DetourPlan): InsertionCheck {
  const outgoing = plan.edges.filter((e) => e.from === plan.node.id);
  if (outgoing.length > 0) {
    return {
      ok: false,
      reason: 'prereq-of-existing',
      detail: 'A side trip may not become a prerequisite of a lesson that already exists.',
    };
  }
  return validateInsertion(graph, plan.node, plan.edges);
}

export function insertDetour(graph: ModuleGraph, plan: DetourPlan): ModuleGraph {
  const check = checkDetourInsertion(graph, plan);
  if (!check.ok) {
    throw err('conflict', { detail: `detour insertion refused: ${check.reason}`, userMessage: check.detail });
  }
  return {
    ...graph,
    nodes: [...graph.nodes, plan.node],
    edges: [...graph.edges, ...plan.edges],
    entryModules: [...graph.entryModules],
  };
}

// WHY (F12 path): abandoning a detour detaches it only. Every core node keeps
// its ordinal, its state and its edges, so core progress is untouched.
export function abandonDetour(graph: ModuleGraph, detourId: ModuleId): ModuleGraph {
  const node = graph.nodes.find((n) => n.id === detourId);
  if (node === undefined || node.kind !== 'detour') {
    throw err('not-found', {
      detail: 'abandonDetour called for a module that is not a detour',
      userMessage: 'That side trip is not part of this topic.',
    });
  }
  return {
    ...graph,
    edges: graph.edges.filter((e) => e.from !== detourId && e.to !== detourId),
  };
}

export function coreProgress(graph: ModuleGraph): { completed: number; total: number } {
  const core = graph.nodes.filter((n) => n.kind === 'module');
  return {
    completed: core.filter((n) => n.state === 'completed' || n.state === 'assisted-pass').length,
    total: core.length,
  };
}
