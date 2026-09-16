// FRACTAL: implements F2 | component C4
import {
  generationPlanSchema,
  type GenerationPhase,
  type GenerationPlan,
  type TopicId,
} from '@/shapes';
import type { NewTopic } from '@/store/topics';
import { MAX_PREP_MODULES } from '@/orchestrator/prep-window';

export {
  generationPlanSchema,
  detourRequestSchema,
  exampleDetourRequest,
  extensionRequestSchema,
  exampleExtensionRequest,
  type GenerationPhase,
  type GenerationPlan,
  type DetourRequest,
  type ExtensionRequest,
} from '@/shapes';

export const PLAN_PHASES: GenerationPhase[] = ['research', 'authoring', 'capstone', 'review'];

export const MIN_MODULES = 6;
// WHY there is no ceiling: "high school biology to MCAT-ready" is a legitimate thing
// to ask for, and it is a degree's worth of lessons. Capping the plan did not make that
// request smaller, it made each lesson wider — the ideas that did not fit in the module
// count were absorbed into modules that then took an hour each. The size of the course
// is the learner's to choose; what is bounded is how much of it is PREPARED at once,
// which is the prep window in @/orchestrator/prep-window, not the plan.
export const MODULES_PER_BREADTH_WORD = 2;

// WHY: the ceiling on a single lesson, in minutes. Anything the outline proposes
// above this is a lesson that spans several topics; it is clamped so the authoring
// brief asks for one sitting's worth of material.
export const MAX_MODULE_MINUTES = 20;
export const DEFAULT_MODULE_MINUTES = 20;
export const MIN_MODULE_MINUTES = 8;

const LEVEL_WEIGHT: Record<NewTopic['level'], number> = {
  beginner: 0,
  intermediate: 2,
  advanced: 4,
  'self-described': 2,
};

// WHY exported: an extension (@/orchestrator/extend) sizes itself from the goal the
// learner typed by the same measure the plan sizes itself from the subject, so that
// "extend this to the MCAT" and "the MCAT" as a subject buy comparable amounts of course.
export function significantWords(text: string): number {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3).length;
}

// WHY the syllabus raises a FLOOR rather than setting the count: the plan is padded or
// truncated to exactly this number later, so a course whose material names fourteen units
// and whose estimate is ten silently drops four of them — the four the learner is going to
// be examined on. A unit is at least a lesson, so the count is at least the unit count.
// It is a floor and not the answer because a syllabus's "Unit 3: Entropy" is a fortnight
// of teaching, and one lesson is twenty minutes: a wider estimate still wins.
export const MAX_UNIT_FLOOR = 60;

export function unitFloor(unitCount: number): number {
  if (!Number.isFinite(unitCount) || unitCount <= 0) return 0;
  return Math.min(MAX_UNIT_FLOOR, Math.floor(unitCount));
}

// WHY: the estimate must be a pure function of the intake, because the number
// the topic page quotes before the learner presses, and the number of sessions the
// engine dispatches are required to be the same number — a random or
// time-dependent estimate would let them drift. Uploaded material is part of the
// intake, so the unit count it declares is an input like the subject and the level.
export function estimateModules(input: NewTopic, unitCount = 0): number {
  const breadth = significantWords(input.subject) + Math.min(6, significantWords(input.purpose));
  const known = input.diagnostic ? input.diagnostic.priorKnowledge.length : 0;
  const raw = MIN_MODULES + breadth * MODULES_PER_BREADTH_WORD + LEVEL_WEIGHT[input.level] - known;
  return Math.max(MIN_MODULES, unitFloor(unitCount), raw);
}

// WHY: a course longer than one prep window is written over several passes, so this is
// how many times the learner is asked to authorise the next batch. It does not change
// what the course costs in total — the sessions are the same sessions, spread out.
export function prepPassesFor(estimatedModules: number): number {
  return Math.max(1, Math.ceil(estimatedModules / MAX_PREP_MODULES));
}

// WHY: one research session + one session per module + one capstone-spec
// session + exactly one discontinuity review, which runs on the pass that finishes
// the course. Running it per pass would spend a session comparing lessons against a
// course that is still half-unwritten, and every gap the later passes were about to
// fill would come back as a finding.
export function sessionCountFor(estimatedModules: number): number {
  return estimatedModules + 3;
}

export function authoringPhaseSessionCount(estimatedModules: number): number {
  return estimatedModules + 2;
}

export function planFor(input: NewTopic, unitCount = 0): GenerationPlan {
  const estimatedModules = estimateModules(input, unitCount);
  return generationPlanSchema.parse({
    estimatedModules,
    sessionCount: sessionCountFor(estimatedModules),
    phases: [...PLAN_PHASES],
  });
}

export type ModuleOutline = {
  title: string;
  objectives: string[];
  estimatedMinutes: number;
  testOutEligible: boolean;
};

export type ResearchOutline = {
  topicId: TopicId;
  drivingQuestion: string;
  modules: ModuleOutline[];
  edges: { from: number; to: number }[];
  fallback: boolean;
};
