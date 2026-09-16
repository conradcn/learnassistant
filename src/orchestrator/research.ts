// FRACTAL: implements F2 | component C4
import { z } from 'zod';
import type { SourceUnit, Topic, ModuleId, TopicId } from '@/shapes';
import type { ModuleBrief } from '@/cli/prompt';
import { log } from '@/core/log';
import { newModuleId } from '@/orchestrator/ids';
import {
  DEFAULT_MODULE_MINUTES,
  MAX_MODULE_MINUTES,
  MIN_MODULE_MINUTES,
  type GenerationPlan,
  type ModuleOutline,
  type ResearchOutline,
} from '@/orchestrator/plan';
import { dispatchSession, READ_ONLY_TOOLS, type DispatchOutcome, type OrchestratorDeps } from '@/orchestrator/session';
import { loadMaterial, researchView, type TopicMaterial } from '@/source/material';

export const RESEARCH_TIMEOUT_MS = 10 * 60 * 1000;

const proposedNodeSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1).max(300),
  objectives: z.array(z.string().max(500)).max(20).optional(),
  estimatedMinutes: z.number().min(1).max(180).optional(),
  testOutEligible: z.boolean().optional(),
});

const proposedEdgeSchema = z.union([
  z.object({ from: z.string(), to: z.string() }),
  z.object({ fromIndex: z.number().int(), toIndex: z.number().int() }),
]);

// WHY: the research session's stdout is untrusted model output, so it is parsed
// against a permissive-but-explicit schema here and every id it contains is
// discarded in favour of ids minted by this process.
export const researchOutputSchema = z.object({
  drivingQuestion: z.string().min(1).max(500).optional(),
  modules: z.array(proposedNodeSchema).max(64).optional(),
  nodes: z.array(proposedNodeSchema).max(64).optional(),
  edges: z.array(proposedEdgeSchema).max(256).optional(),
});
export type ResearchOutput = z.infer<typeof researchOutputSchema>;

export function drivingQuestionFallback(topic: Topic): string {
  const purpose = topic.purpose.trim();
  return purpose.length > 0
    ? `What do you need to understand about ${topic.subject} to ${purpose}?`
    : `What does it really take to understand ${topic.subject}?`;
}

function genericTitles(subject: string, count: number): string[] {
  const shape = [
    'Foundations and vocabulary',
    'The core idea',
    'How it is measured',
    'Worked examples',
    'Common pitfalls',
    'Edge cases and limits',
    'How the pieces connect',
    'Applying it to a real problem',
    'Alternatives and trade-offs',
    'Reading the literature',
    'Tooling and practice',
    'Putting it all together',
  ];
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(`${subject}: ${shape[i % shape.length]}${i >= shape.length ? ` (${Math.floor(i / shape.length) + 1})` : ''}`);
  }
  return out;
}

// WHY: research finding no suitable outline is a declared path, not a failure —
// the topic keeps generating over a generic decomposition by subtopic.
export function genericDecomposition(topic: Topic, plan: GenerationPlan): ResearchOutline {
  const titles = genericTitles(topic.subject, plan.estimatedModules);
  const modules: ModuleOutline[] = titles.map((title) => ({
    title,
    objectives: [`Be able to explain ${title.toLowerCase()} in your own words.`],
    estimatedMinutes: DEFAULT_MODULE_MINUTES,
    testOutEligible: false,
  }));
  // A wide, shallow default: one entry module, everything else hangs off it, so
  // several modules are available at once rather than one long chain.
  const edges = modules.slice(1).map((_m, i) => ({ from: 0, to: i + 1 }));
  return { topicId: topic.id, drivingQuestion: drivingQuestionFallback(topic), modules, edges, fallback: true };
}

// WHY: the outline may propose up to 180 minutes for a module, and it used to be
// taken at its word — the authoring brief then asked for a lesson that big and the
// learner got several topics in one sitting. A module is one sitting; anything longer
// is a module that should have been split, so the estimate is clamped rather than
// trusted, and the outline is asked for enough modules that clamping is not a lie.
export function clampModuleMinutes(minutes: number | undefined): number {
  if (minutes === undefined || !Number.isFinite(minutes)) return DEFAULT_MODULE_MINUTES;
  return Math.max(MIN_MODULE_MINUTES, Math.min(MAX_MODULE_MINUTES, Math.round(minutes)));
}

function knownPriorKnowledge(topic: Topic): string[] {
  return topic.diagnostic?.priorKnowledge ?? [];
}

function marksTestOut(title: string, priorKnowledge: string[]): boolean {
  const lower = title.toLowerCase();
  return priorKnowledge.some((known) => {
    const term = known.trim().toLowerCase();
    return term.length >= 4 && lower.includes(term);
  });
}

const COVERAGE_STOPWORDS = new Set([
  'and', 'the', 'for', 'with', 'from', 'that', 'this', 'into', 'unit', 'week', 'part',
  'module', 'chapter', 'lesson', 'topic', 'section', 'lecture', 'introduction', 'overview',
]);

function coverageTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !COVERAGE_STOPWORDS.has(w)),
  );
}

/**
 * Whether any proposed module plausibly teaches this unit.
 *
 * WHY token overlap and not a model call: this runs after research has already been paid
 * for, and the question is narrow — does the word the syllabus uses for this unit appear
 * in the title of any lesson? A unit whose distinctive words appear nowhere is a unit the
 * outline did not cover, whatever it believes.
 */
export function unitCovered(unit: SourceUnit, titles: string[]): boolean {
  const wanted = coverageTokens(unit.title);
  if (wanted.size === 0) return true;
  return titles.some((title) => {
    const have = coverageTokens(title);
    let hits = 0;
    for (const token of wanted) if (have.has(token)) hits += 1;
    // Half the unit's distinctive words, or both of them when it only has two.
    return hits > 0 && hits * 2 >= Math.min(wanted.size, 4);
  });
}

/** The units the material names that nothing in the outline reaches, in the book's order. */
export function uncoveredUnits(units: SourceUnit[], titles: string[]): SourceUnit[] {
  return units.filter((unit) => !unitCovered(unit, titles));
}

// WHY: the plan's estimatedModules is the number the topic page quoted before the
// learner pressed, so the outline is padded or truncated to exactly that count. The
// model may shape the graph; it may not change how many sessions run.
export function normalizeOutline(
  topic: Topic,
  plan: GenerationPlan,
  raw: ResearchOutput,
  material: TopicMaterial | null = null,
): ResearchOutline {
  const proposed = raw.modules ?? raw.nodes ?? [];
  const priorKnowledge = knownPriorKnowledge(topic);
  const generic = genericTitles(topic.subject, plan.estimatedModules);

  const modules: ModuleOutline[] = [];
  const seenTitles = new Set<string>();
  for (const node of proposed) {
    if (modules.length >= plan.estimatedModules) break;
    const title = node.title.trim().slice(0, 300);
    if (title.length === 0 || seenTitles.has(title)) continue;
    seenTitles.add(title);
    modules.push({
      title,
      objectives: (node.objectives ?? [`Be able to explain ${title} in your own words.`]).slice(0, 12),
      estimatedMinutes: clampModuleMinutes(node.estimatedMinutes),
      testOutEligible: node.testOutEligible === true || marksTestOut(title, priorKnowledge),
    });
  }
  // WHY this is enforced here and not only asked for in the prompt: "where the material
  // names a unit there are lessons that cover it" is a promise to the learner, and a
  // promise kept only when the model chooses to cooperate is not one.
  //
  // WHY room is TAKEN and not merely hoped for: the plan floor (`unitFloor`) guarantees
  // the count is at least the unit count, but nothing stops the outline from spending
  // every one of those slots on titles of its own. When it has, the tail of what it
  // proposed is dropped to make room — the units come from the course the learner is
  // actually sitting, and they outrank a title research thought of. The prefix it keeps is
  // never smaller than the slots the estimate had ABOVE the unit count, so a wider
  // estimate still buys researched lessons.
  if (material !== null && material.units.length > 0) {
    for (let round = 0; round < material.units.length; round += 1) {
      const uncovered = uncoveredUnits(
        material.units,
        modules.map((m) => m.title),
      ).filter((u) => !seenTitles.has(u.title.slice(0, 300)));
      if (uncovered.length === 0) break;
      if (modules.length >= plan.estimatedModules) modules.pop();
      const unit = uncovered[0];
      const title = unit.title.slice(0, 300);
      const named = unit.label === unit.title ? unit.title : `${unit.label}, "${unit.title}",`;
      seenTitles.add(title);
      modules.push({
        title,
        objectives: [
          `Cover ${named} as the material the learner brought sets it out.`,
          "Use that material's vocabulary and notation for this idea.",
        ],
        estimatedMinutes: DEFAULT_MODULE_MINUTES,
        testOutEligible: marksTestOut(title, priorKnowledge),
      });
    }
  }

  let filler = 0;
  while (modules.length < plan.estimatedModules) {
    const title = generic[filler % generic.length] + (filler >= generic.length ? ` (${filler})` : '');
    filler += 1;
    if (seenTitles.has(title)) continue;
    seenTitles.add(title);
    modules.push({
      title,
      objectives: [`Be able to explain ${title.toLowerCase()} in your own words.`],
      estimatedMinutes: DEFAULT_MODULE_MINUTES,
      testOutEligible: marksTestOut(title, priorKnowledge),
    });
  }

  const indexOfProposedId = new Map<string, number>();
  proposed.forEach((node, i) => {
    if (node.id !== undefined) indexOfProposedId.set(node.id, i);
    indexOfProposedId.set(node.title.trim().slice(0, 300), i);
  });

  const edges: { from: number; to: number }[] = [];
  const seenEdges = new Set<string>();
  for (const edge of raw.edges ?? []) {
    const from = 'from' in edge ? indexOfProposedId.get(edge.from) : edge.fromIndex;
    const to = 'from' in edge ? indexOfProposedId.get(edge.to) : edge.toIndex;
    if (from === undefined || to === undefined) continue;
    if (from === to) continue;
    if (from < 0 || to < 0 || from >= modules.length || to >= modules.length) continue;
    const key = `${from}->${to}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push({ from, to });
  }

  const hasEntry = modules.some((_m, i) => !edges.some((e) => e.to === i));
  if (!hasEntry && modules.length > 0) {
    for (let i = edges.length - 1; i >= 0; i -= 1) {
      if (edges[i].to === 0) edges.splice(i, 1);
    }
  }

  return {
    topicId: topic.id,
    drivingQuestion: (raw.drivingQuestion ?? '').trim() || drivingQuestionFallback(topic),
    modules,
    edges,
    fallback: false,
  };
}

export function outlineIds(outline: ResearchOutline): ModuleId[] {
  return outline.modules.map(() => newModuleId());
}

// WHY these are objectives and not part of the shared guidance block: the guidance in C2
// says how to READ the material; these say what the plan that comes back must satisfy.
// Both are needed — one without the other produced outlines that quoted the syllabus
// faithfully and still left a third of its units with no lesson to their name.
function materialObjectives(material: TopicMaterial): string[] {
  const out = [
    'The learner brought their own material for this subject; it is quoted below.',
    'Cover every unit it names. A unit with no module covering it is the failure to avoid.',
    'Follow its order unless a prerequisite genuinely requires otherwise.',
    'Title modules with its words, so the plan reads like the course they are actually taking.',
    'Add modules it does not have where it assumes background it never teaches.',
  ];
  if (material.units.length > 0) {
    out.push(`It names ${material.units.length} unit(s); the module count above already allows for them.`);
  }
  return out;
}

export function researchBrief(topic: Topic, plan: GenerationPlan, material: TopicMaterial | null = null): ModuleBrief {
  return {
    ...(material === null ? {} : { sourceMaterial: researchView(material) }),
    topicSubject: topic.subject,
    level: topic.level,
    levelDetail: topic.levelDetail ?? null,
    purpose: topic.purpose,
    drivingQuestion: drivingQuestionFallback(topic),
    moduleTitle: `Plan ${plan.estimatedModules} lessons for ${topic.subject}`,
    moduleObjectives: [
      `Propose exactly ${plan.estimatedModules} modules covering ${topic.subject}.`,
      `One module teaches ONE idea and is finished in ${MAX_MODULE_MINUTES} minutes. That is the size to plan to.`,
      'A title that joins several topics with "and" or a comma — "Symbols, Indices, and Shapes",' +
        ' "Gradients, Jacobians, and the Chain Rule" — is several modules. Split it into one per idea.',
      'Spend the module count on splitting the subject finer, not on covering more ground:' +
        ' it is better to teach the same material in more, smaller steps than to widen any one module.',
      'Add a prerequisite edge only where understanding genuinely depends on the other module.',
      'Prefer a wide, shallow graph over a long chain so several modules are open at once.',
      'Propose one driving question that anchors the whole topic.',
      ...(material === null ? [] : materialObjectives(material)),
    ],
    prerequisiteSummaries: [],
    downstreamSummaries: [],
    priorKnowledge: knownPriorKnowledge(topic),
    targetMinutes: MAX_MODULE_MINUTES,
  };
}

export type ResearchResult = { outline: ResearchOutline; ids: ModuleId[]; failureReason: string | null };

export async function runResearch(
  deps: OrchestratorDeps,
  topic: Topic,
  plan: GenerationPlan,
  workspaceModuleId: ModuleId,
  signal: AbortSignal,
): Promise<ResearchResult> {
  const material = loadMaterial(deps.store, deps.dataRoot, topic.id);
  const brief = researchBrief(topic, plan, material);
  const outcome: DispatchOutcome = await dispatchSession(deps, {
    kind: 'generate-topic',
    topicId: topic.id as TopicId,
    workspaceModuleId,
    ephemeralWorkspace: true,
    brief,
    outputSchema: researchOutputSchema,
    timeoutMs: RESEARCH_TIMEOUT_MS,
    maxTurns: 20,
    allowedTools: READ_ONLY_TOOLS,
    signal,
  });

  // WHY the fallback is normalized rather than returned raw when there is material: a
  // failed research session is exactly the case where the learner's own syllabus is the
  // best plan available. Without this, the one path where the material matters most threw
  // it away and split the subject up by generic subtopic instead.
  const fallback = (): ResearchResult => {
    const generic = genericDecomposition(topic, plan);
    if (material === null) {
      return {
        outline: generic,
        ids: outlineIds(generic),
        failureReason: 'Could not research an outline for this subject, so the lessons were split up by subtopic instead.',
      };
    }
    const outline = normalizeOutline(
      topic,
      plan,
      { drivingQuestion: generic.drivingQuestion, modules: generic.modules.map((m) => ({ title: m.title, objectives: m.objectives })) },
      material,
    );
    return {
      outline: { ...outline, fallback: true },
      ids: outlineIds(outline),
      failureReason:
        'Could not research an outline for this subject, so the lessons follow the material you uploaded and its own order.',
    };
  };

  if (!outcome.ok) {
    log({ level: 'warn', event: 'orchestrator-research-fallback', component: 'C4', topicId: topic.id, code: outcome.code });
    return fallback();
  }

  const parsed = researchOutputSchema.safeParse(outcome.output);
  if (!parsed.success) return fallback();

  const outline = normalizeOutline(topic, plan, parsed.data, material);
  return { outline, ids: outlineIds(outline), failureReason: null };
}
