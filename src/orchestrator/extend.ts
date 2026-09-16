// FRACTAL: implements F12 | component C4
import type { ModuleGraph, ModuleId, ModuleNode, PrereqEdge, Topic, TopicStatus } from '@/shapes';
import { log } from '@/core/log';
import { newModuleId } from '@/orchestrator/ids';
import { capstoneLeafPrereqs } from '@/orchestrator/capstone-spec';
import {
  DEFAULT_MODULE_MINUTES,
  MAX_MODULE_MINUTES,
  MODULES_PER_BREADTH_WORD,
  significantWords,
  type ModuleOutline,
} from '@/orchestrator/plan';
import { clampModuleMinutes, researchOutputSchema, type ResearchOutput } from '@/orchestrator/research';
import { dispatchSession, READ_ONLY_TOOLS, type DispatchOutcome, type OrchestratorDeps } from '@/orchestrator/session';
import { loadMaterial, researchView } from '@/source/material';
import type { ModuleBrief, SourceMaterialBrief } from '@/cli/prompt';

export const EXTENSION_TIMEOUT_MS = 10 * 60 * 1000;

export const EXTEND_BLOCKED_MESSAGE =
  'This subject is being worked on right now. Wait for that to finish, then you can extend it.';
export const EXTEND_UNPLANNED_MESSAGE =
  'There are no lessons to extend yet. Plan this subject first, then you can take it further.';

/**
 * How much course an extension buys, in lessons.
 *
 * WHY it is sized from the goal and not fixed: "and the pharmacology chapter too" and
 * "sufficient knowledge for the MCAT" are the same button and are not the same amount of
 * teaching. The formula is the plan's own — a lesson is one idea in one sitting, so a wider
 * goal buys MORE lessons rather than wider ones (see @/orchestrator/plan).
 *
 * WHY there IS a ceiling here where the plan has none: the plan's size is bounded by an
 * intake the learner filled in once, and by material they uploaded. This one is bounded by a
 * sentence typed into a box on a course that already exists. An extension is an addition to a
 * curriculum, not a second curriculum stapled to it; a learner who wants that adds a subject.
 */
export const MIN_EXTENSION_MODULES = 4;
export const MAX_EXTENSION_MODULES = 40;

export function extensionSize(goal: string): number {
  const raw = MIN_EXTENSION_MODULES + significantWords(goal) * MODULES_PER_BREADTH_WORD;
  return Math.max(MIN_EXTENSION_MODULES, Math.min(MAX_EXTENSION_MODULES, raw));
}

/**
 * WHY `needs-attention` is allowed here where a detour refuses it: a detour is a lesson hung
 * off a lesson the learner is in the middle of, so a course in trouble is a bad place to put
 * one. An extension is planning, and the ordinary healthy way a research pass hands a subject
 * back IS `needs-attention` — refusing it would mean a course could not be extended at any
 * point between its outline landing and its last lesson being written, which is most of the
 * life of a long course. What is refused is a pass already under way, because two passes
 * appending to the same graph would each be working from a graph the other had not written.
 */
export function extendAllowedForStatus(status: TopicStatus): boolean {
  return status !== 'queued' && status !== 'generating';
}

const EXTENSION_SHAPE = [
  'Where it starts from',
  'The idea it rests on',
  'How it is used',
  'Worked examples',
  'What people get wrong',
  'Edge cases and limits',
  'Connecting it back',
  'Putting it to work',
];

/** The plan when the research session for an extension does not come back with one. */
export function genericExtension(goal: string, count: number): ModuleOutline[] {
  const stem = goal.trim().slice(0, 120);
  return Array.from({ length: count }, (_v, i) => {
    const shape = EXTENSION_SHAPE[i % EXTENSION_SHAPE.length];
    const round = i >= EXTENSION_SHAPE.length ? ` (${Math.floor(i / EXTENSION_SHAPE.length) + 1})` : '';
    return {
      title: `${stem}: ${shape}${round}`,
      objectives: [`Be able to explain ${shape.toLowerCase()} for ${stem}, in your own words.`],
      estimatedMinutes: DEFAULT_MODULE_MINUTES,
      testOutEligible: false,
    };
  });
}

export type ExtensionOutline = {
  modules: ModuleOutline[];
  edges: { from: number; to: number }[];
  fallback: boolean;
};

function titleKey(title: string): string {
  return title.trim().toLowerCase();
}

/**
 * The proposed extension, cut to exactly `count` lessons and stripped of anything the course
 * already teaches.
 *
 * WHY the dedupe against the existing titles is here and not only in the prompt: the whole
 * point of extending a course rather than starting a second one is that the lessons already
 * written are not written again, and a plan that re-teaches four lessons the learner has
 * already passed spends four real sessions saying so.
 */
export function normalizeExtension(
  goal: string,
  count: number,
  raw: ResearchOutput,
  existingTitles: readonly string[],
): ExtensionOutline {
  const proposed = raw.modules ?? raw.nodes ?? [];
  const seen = new Set(existingTitles.map(titleKey));
  const modules: ModuleOutline[] = [];
  const keptIndexes = new Map<number, number>();

  proposed.forEach((node, i) => {
    if (modules.length >= count) return;
    const title = node.title.trim().slice(0, 300);
    if (title.length === 0 || seen.has(titleKey(title))) return;
    seen.add(titleKey(title));
    keptIndexes.set(i, modules.length);
    modules.push({
      title,
      objectives: (node.objectives ?? [`Be able to explain ${title} in your own words.`]).slice(0, 12),
      estimatedMinutes: clampModuleMinutes(node.estimatedMinutes),
      testOutEligible: node.testOutEligible === true,
    });
  });

  const fallback = modules.length === 0;
  for (const filler of genericExtension(goal, count)) {
    if (modules.length >= count) break;
    if (seen.has(titleKey(filler.title))) continue;
    seen.add(titleKey(filler.title));
    modules.push(filler);
  }

  // WHY the edges are remapped rather than taken as given: an index the outline used may
  // name a lesson this pass dropped as a duplicate, and an edge into a lesson that is not
  // being added is an edge to nothing.
  const indexOfProposedId = new Map<string, number>();
  proposed.forEach((node, i) => {
    if (node.id !== undefined) indexOfProposedId.set(node.id, i);
    indexOfProposedId.set(node.title.trim().slice(0, 300), i);
  });
  const edges: { from: number; to: number }[] = [];
  const seenEdges = new Set<string>();
  for (const edge of raw.edges ?? []) {
    const rawFrom = 'from' in edge ? indexOfProposedId.get(edge.from) : edge.fromIndex;
    const rawTo = 'from' in edge ? indexOfProposedId.get(edge.to) : edge.toIndex;
    if (rawFrom === undefined || rawTo === undefined) continue;
    const from = keptIndexes.get(rawFrom);
    const to = keptIndexes.get(rawTo);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}->${to}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push({ from, to });
  }

  return { modules, edges, fallback };
}

/**
 * The lessons at the end of the course as it stands: the ones nothing else in it follows.
 *
 * WHY this is not `capstoneLeafPrereqs`: that one reads every edge, and on a course that
 * already has a final project every leaf has an outgoing edge into it — so it would answer
 * "there are no leaves" and hand back the whole course. Here the capstone is not part of the
 * question; it is moved to the new end afterwards.
 */
export function courseFrontier(graph: ModuleGraph): ModuleId[] {
  const core = graph.nodes.filter((n) => n.kind !== 'capstone');
  const coreIds = new Set(core.map((n) => n.id));
  const hasCoreSuccessor = new Set(graph.edges.filter((e) => coreIds.has(e.to)).map((e) => e.from));
  const leaves = core.filter((n) => !hasCoreSuccessor.has(n.id)).map((n) => n.id);
  return leaves.length > 0 ? leaves : core.map((n) => n.id);
}

export type ExtensionPlan = { nodes: ModuleNode[]; edges: PrereqEdge[] };

/**
 * Where the new lessons hang.
 *
 * WHY the extension is attached to the ends of the existing course rather than to nothing:
 * the goal it was asked for ("enough for the MCAT") CONTINUES the course, and a lesson from
 * it that the learner could open on day one would be a lesson taught out of order.
 */
export function planExtension(graph: ModuleGraph, outline: ExtensionOutline): ExtensionPlan {
  const frontier = courseFrontier(graph);
  const maxOrdinal = graph.nodes.reduce((max, n) => Math.max(max, n.ordinal), 0);

  const ids = outline.modules.map(() => newModuleId());
  const nodes: ModuleNode[] = outline.modules.map((m, i) => ({
    id: ids[i],
    topicId: graph.topicId,
    title: m.title,
    ordinal: maxOrdinal + 1 + i,
    kind: 'module',
    testOutEligible: m.testOutEligible,
    estimatedMinutes: m.estimatedMinutes,
    state: 'available',
    content: null,
  }));

  const internal: PrereqEdge[] = outline.edges
    .filter((e) => e.from < ids.length && e.to < ids.length)
    .map((e) => ({ from: ids[e.from], to: ids[e.to] }));
  const hasIncoming = new Set(internal.map((e) => e.to));
  const entries = ids.filter((id) => !hasIncoming.has(id));
  const anchors: PrereqEdge[] = [];
  for (const from of frontier) {
    for (const to of entries) anchors.push({ from, to });
  }

  return { nodes, edges: [...internal, ...anchors] };
}

/**
 * The graph with the extension in it, and the final project moved back behind it.
 *
 * WHY the capstone is re-hung rather than left where it was: it is the finale of the course,
 * and a course that has just grown has a new end. Left alone, the final project would become
 * available while the lessons it is now supposed to come after were still unopened — and a
 * learner who finished it would flip the whole subject to `done` with half of what they
 * asked for unwritten.
 */
export function insertExtension(graph: ModuleGraph, plan: ExtensionPlan): ModuleGraph {
  const capstone = graph.nodes.find((n) => n.kind === 'capstone') ?? null;
  const kept = capstone === null ? graph.edges : graph.edges.filter((e) => e.to !== capstone.id);
  const grown: ModuleGraph = {
    ...graph,
    nodes: [...graph.nodes, ...plan.nodes],
    edges: [...kept, ...plan.edges],
  };
  if (capstone === null) return grown;
  const capstoneEdges = capstoneLeafPrereqs(grown, capstone.id).map((from) => ({ from, to: capstone.id }));
  const ordinal = grown.nodes.reduce((max, n) => (n.kind === 'capstone' ? max : Math.max(max, n.ordinal)), 0) + 1;
  return {
    ...grown,
    nodes: grown.nodes.map((n) => (n.id === capstone.id ? { ...n, ordinal } : n)),
    edges: [...grown.edges, ...capstoneEdges],
  };
}

export function extensionBrief(
  topic: Topic,
  goal: string,
  drivingQuestion: string,
  existing: readonly ModuleNode[],
  count: number,
  sourceMaterial?: SourceMaterialBrief,
): ModuleBrief {
  return {
    ...(sourceMaterial === undefined ? {} : { sourceMaterial }),
    topicSubject: topic.subject,
    level: topic.level,
    levelDetail: topic.levelDetail ?? null,
    purpose: topic.purpose,
    drivingQuestion,
    moduleTitle: `Extend ${topic.subject} to: ${goal}`,
    // WHY the existing titles ride in `prerequisiteSummaries`: that is the field the prompt
    // renders as "what the learner already has before this", which is exactly what a course
    // being extended is. The one instruction that matters here is not to write it twice.
    moduleObjectives: [
      `This course already exists — its lessons are listed below. Plan exactly ${count} NEW modules that carry it to a further goal.`,
      `The further goal, in the learner's own words: ${goal}`,
      'Plan only what is MISSING for that goal. Do not re-teach a lesson the course already has,' +
        ' and do not restate one under a new name.',
      `One module teaches ONE idea and is finished in ${MAX_MODULE_MINUTES} minutes. That is the size to plan to.`,
      'A title that joins several topics with "and" or a comma is several modules. Split it into one per idea.',
      'Add a prerequisite edge only where understanding genuinely depends on another NEW module:' +
        ' the existing course is already a prerequisite of every one of them.',
      'Prefer a wide, shallow graph over a long chain so several are open at once.',
      'Keep the existing driving question. Do not propose a new one.',
    ],
    // WHY each existing lesson is summarised by its first learning goal and not just named:
    // "Enzymes" as a title says nothing about how far the course took them, and the one
    // judgement this pass has to make is what is MISSING.
    prerequisiteSummaries: existing.map((n) => ({
      title: n.title.slice(0, 300),
      oneLine: n.content?.learningGoals[0] ?? 'Planned, not written yet.',
    })),
    downstreamSummaries: [],
    priorKnowledge: topic.diagnostic?.priorKnowledge ?? [],
    targetMinutes: MAX_MODULE_MINUTES,
  };
}

export type ExtensionResult = { outline: ExtensionOutline; failureReason: string | null };

export async function runExtensionResearch(
  deps: OrchestratorDeps,
  topic: Topic,
  goal: string,
  drivingQuestion: string,
  graph: ModuleGraph,
  signal: AbortSignal,
): Promise<ExtensionResult> {
  const count = extensionSize(goal);
  const existing = graph.nodes.filter((n) => n.kind !== 'capstone');
  const existingTitles = existing.map((n) => n.title);
  const material = loadMaterial(deps.store, deps.dataRoot, topic.id);
  const brief = extensionBrief(
    topic,
    goal,
    drivingQuestion,
    existing,
    count,
    material === null ? undefined : researchView(material),
  );
  const outcome: DispatchOutcome = await dispatchSession(deps, {
    kind: 'extend',
    topicId: topic.id,
    workspaceModuleId: newModuleId(),
    ephemeralWorkspace: true,
    brief,
    outputSchema: researchOutputSchema,
    timeoutMs: EXTENSION_TIMEOUT_MS,
    maxTurns: 20,
    allowedTools: READ_ONLY_TOOLS,
    signal,
  });

  // WHY there is a fallback at all: the learner has already pressed the button, and an
  // extension that fails outright leaves the course exactly as long as it was with nothing
  // to show for the press. A split by subtopic is a worse plan than a researched one and a
  // far better one than none — and it is named as a fallback in a note, as research is.
  const fallback = (): ExtensionResult => ({
    outline: { modules: genericExtension(goal, count), edges: [], fallback: true },
    failureReason:
      'Could not research the extra lessons for that goal, so they were split up by subtopic instead.',
  });

  if (!outcome.ok) {
    log({
      level: 'warn',
      event: 'orchestrator-extension-fallback',
      component: 'C4',
      topicId: topic.id,
      code: outcome.code,
    });
    return fallback();
  }
  const parsed = researchOutputSchema.safeParse(outcome.output);
  if (!parsed.success) return fallback();

  return { outline: normalizeExtension(goal, count, parsed.data, existingTitles), failureReason: null };
}
