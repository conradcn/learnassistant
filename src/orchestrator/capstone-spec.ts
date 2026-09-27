// FRACTAL: implements F2 | component C4
import { z } from 'zod';
import { sessionIdSchema, type ModuleContent, type ModuleGraph, type ModuleId, type ModuleNode, type Topic, type TopicNote } from '@/shapes';
import { log } from '@/core/log';
import { nowIso } from '@/orchestrator/ids';
import { commitModule } from '@/orchestrator/reconcile';
import { authoringBrief } from '@/orchestrator/author-module';
import { loadMaterial } from '@/source/material';
import { READ_ONLY_TOOLS, dispatchSession, type OrchestratorDeps } from '@/orchestrator/session';

export const CAPSTONE_TIMEOUT_MS = 10 * 60 * 1000;
export const MIN_PURPOSE_WORDS = 3;

export const capstoneOutputSchema = z.object({
  spec: z.string().min(1).max(20000),
  drivingQuestionRef: z.string().max(500).optional(),
  purposeRef: z.string().max(2000).optional(),
  deliverables: z.array(z.string().max(500)).max(20).optional(),
  passCriteria: z.array(z.string().max(500)).max(20).optional(),
});

// WHY (F13): the tutor proposes the project. A brief that leaves the learner to pick the
// case, find the sources, or invent the problem hands them the hardest part of the design
// before they have been taught enough to judge it — and a project they invented cannot be
// checked against anything the course set. What is left to the learner is the building:
// design decisions inside a problem the brief has already fixed.
export const TUTOR_PROPOSES_OBJECTIVE =
  'Propose ONE concrete project yourself and fix everything it is about: the scenario, the givens ' +
  '(the case, data, system, documents or figures it works on, written into the brief) and exactly ' +
  'what gets built. Never leave the learner to invent the project, choose its subject or case, or go ' +
  'and find the sources it is about. The only choices left to them are design decisions inside the ' +
  'problem you set, and any options you offer are ones you wrote out in full.';

// WHY (F13 path): a purpose too vague to build against falls back to a synthesis
// design problem spanning the topic's modules, rather than producing a capstone
// that references nothing.
export function purposeIsBuildable(purpose: string): boolean {
  return purpose.trim().split(/\s+/).filter((w) => w.length > 2).length >= MIN_PURPOSE_WORDS;
}

export function capstoneLeafPrereqs(graph: ModuleGraph, capstoneId: ModuleId): ModuleId[] {
  const nonCapstone = graph.nodes.filter((n) => n.kind !== 'capstone' && n.id !== capstoneId);
  const hasOutgoing = new Set(graph.edges.map((e) => e.from));
  const leaves = nonCapstone.filter((n) => !hasOutgoing.has(n.id)).map((n) => n.id);
  return leaves.length > 0 ? leaves : nonCapstone.map((n) => n.id);
}

// WHY it is the driving question and not "a problem in <subject>": this is the brief used
// when no session wrote one, and it still has to be the tutor's project. The one problem
// this course has already posed is its driving question, so that is the problem.
export function synthesisSpec(topic: Topic, drivingQuestion: string, graph: ModuleGraph): string {
  const titles = graph.nodes.filter((n) => n.kind !== 'capstone').map((n) => n.title);
  return [
    `Driving question: ${drivingQuestion}`,
    `Your stated purpose: ${topic.purpose.trim() || '(you did not say yet — this project spans the whole topic instead)'}`,
    '',
    `Your project is to answer the driving question in full, as a worked explanation of ${topic.subject} that someone else could follow and check.`,
    'Build the answer out of the lessons below, in order: for each one, write the step of the answer it supplies and the reasoning behind it, then say what you would measure or check to know the whole answer holds.',
    '',
    ...titles.map((t) => `- ${t}`),
  ].join('\n');
}

export function capstoneContent(
  topic: Topic,
  drivingQuestion: string,
  spec: string,
  passCriteria: string[],
): ModuleContent {
  return {
    learningGoals: [
      `Build something real that answers: ${drivingQuestion}`,
      `Serve your own purpose: ${topic.purpose.trim() || `going deeper into ${topic.subject}`}`,
    ],
    warmUp: {
      prompt: 'Before you start building: sketch what "finished" looks like, in one paragraph.',
      expectedStruggle: 'Describing activities instead of describing the finished artefact.',
    },
    explanation: { kind: 'text', markdown: spec },
    visualization: { kind: 'none' },
    evalScript: {
      objectives: [`Answer the driving question through a built artefact: ${drivingQuestion}`],
      seedQuestions: ['Walk me through the piece of this you are least sure about, and why you made that choice.'],
      angles: ['design trade-offs', 'what you would measure', 'what you would do differently'],
      misconceptions: [],
      passCriteria: passCriteria.length > 0 ? passCriteria : ['The submitted work is complete and every design choice is justified.'],
    },
    authoredAt: nowIso(),
    authoredBySession: sessionIdSchema.parse('s_AAAAAAAAAAAAAAAA'),
  };
}

export type CapstoneOutcome =
  | { ok: true; node: ModuleNode; usedSynthesisFallback: boolean }
  | { ok: false; note: TopicNote };

export async function authorCapstoneSpec(
  deps: OrchestratorDeps,
  topic: Topic,
  drivingQuestion: string,
  graph: ModuleGraph,
  node: ModuleNode,
  signal: AbortSignal,
): Promise<CapstoneOutcome> {
  const buildable = purposeIsBuildable(topic.purpose);
  const objectives = [
    `Reference the driving question verbatim: ${drivingQuestion}`,
    buildable
      ? `Specify an artefact the learner builds that serves their purpose: ${topic.purpose}`
      : 'The learner did not state a concrete purpose — specify a synthesis design problem spanning every module instead.',
    TUTOR_PROPOSES_OBJECTIVE,
  ];
  // The project is the thing the course was for, so it is written against the material
  // the learner brought as much as any lesson is.
  const brief = authoringBrief(
    topic,
    drivingQuestion,
    graph,
    node,
    objectives,
    loadMaterial(deps.store, deps.dataRoot, topic.id),
  );

  const outcome = await dispatchSession(deps, {
    kind: 'capstone-spec',
    topicId: topic.id,
    workspaceModuleId: node.id,
    brief,
    outputSchema: capstoneOutputSchema,
    timeoutMs: CAPSTONE_TIMEOUT_MS,
    maxTurns: 20,
    allowedTools: READ_ONLY_TOOLS,
    signal,
  });

  if (!outcome.ok) {
    log({ level: 'warn', event: 'orchestrator-capstone-failed', component: 'C4', topicId: topic.id, code: outcome.code });
    return {
      ok: false,
      note: {
        kind: 'generation-failure',
        message: `The project brief could not be written. ${outcome.message}`,
        affectedModules: [node.id],
        createdAt: nowIso(),
      },
    };
  }

  const parsed = capstoneOutputSchema.safeParse(outcome.output);
  // WHY the session's brief is kept even for a vague purpose: the objectives above already
  // asked it for the synthesis problem in that case, and a problem it wrote against the
  // course is more concrete than the template. The template is for when nothing usable came back.
  const usedSynthesisFallback = !buildable || !parsed.success;
  const specBody = parsed.success ? parsed.data.spec : synthesisSpec(topic, drivingQuestion, graph);
  // WHY (F13 AC): the driving question and the learner's purpose are prepended
  // by us, so the spec always references them even if the model omitted them.
  const spec = [
    `Driving question: ${drivingQuestion}`,
    `Your purpose: ${topic.purpose.trim() || `going deeper into ${topic.subject}`}`,
    '',
    specBody,
  ].join('\n');

  const committed = commitModule(
    deps.store,
    deps.dataRoot,
    node,
    capstoneContent(topic, drivingQuestion, spec, parsed.success ? (parsed.data.passCriteria ?? []) : []),
  );
  return { ok: true, node: committed, usedSynthesisFallback };
}
