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

export function synthesisSpec(topic: Topic, drivingQuestion: string, graph: ModuleGraph): string {
  const titles = graph.nodes.filter((n) => n.kind !== 'capstone').map((n) => n.title);
  return [
    `Driving question: ${drivingQuestion}`,
    `Your stated purpose: ${topic.purpose.trim() || '(you did not say yet — this project spans the whole topic instead)'}`,
    '',
    `Design and fully specify a solution to a problem in ${topic.subject} that only works if you use ideas from every lesson below.`,
    'Hand in the design, the reasoning behind each choice, and what you would measure to know it worked.',
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
  const usedSynthesisFallback = !buildable || !parsed.success;
  const specBody = parsed.success && buildable ? parsed.data.spec : synthesisSpec(topic, drivingQuestion, graph);
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
