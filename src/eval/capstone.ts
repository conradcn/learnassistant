// FRACTAL: implements F13 | component C6
import {
  capstoneSubmissionSchema,
  type AssistLevel,
  type Capstone,
  type CapstoneSubmission,
  type EvalSession,
  type EvalTurn,
  type EvalVerdict,
  type ModuleGraph,
  type ModuleNode,
  type Topic,
} from '@/shapes';
import { isPassedState } from '@/graph/availability';
import { outcomeOfTurn } from '@/eval/turn-id';

export const MAX_CAPSTONE_ARTIFACT_BYTES = 8 * 1024;

export function capstoneNode(graph: ModuleGraph): ModuleNode | null {
  return graph.nodes.find((n) => n.kind === 'capstone') ?? null;
}

// WHY: C1 exposes no capstone repository, so the round record is reconstructed
// from the eval transcript, which IS persisted per turn. The evaluator turn's
// id carries the round's outcome, so a restart can still tell a passed round
// from a revise-and-resubmit one.
function verdictFrom(turn: EvalTurn, outcome: EvalVerdict['outcome']): EvalVerdict {
  return {
    outcome,
    assistLevel: (turn.assistLevel ?? 0) as AssistLevel,
    misunderstanding: null,
    nextAngle: null,
    remedialNeeded: false,
    rationale: turn.text,
  };
}

// WHY (F13 AC): prior-round feedback stays visible across revisions — every
// round ever submitted is returned, in order, never just the latest one.
export function capstoneRounds(session: EvalSession): CapstoneSubmission[] {
  const rounds: CapstoneSubmission[] = [];
  for (let i = 0; i < session.turns.length; i += 1) {
    const turn = session.turns[i];
    if (turn.role !== 'learner') continue;
    const reply = session.turns.slice(i + 1).find((t) => t.role === 'evaluator') ?? null;
    const outcome = reply === null ? null : outcomeOfTurn(reply);
    rounds.push(
      capstoneSubmissionSchema.parse({
        round: rounds.length + 1,
        artifact: turn.text,
        feedback: reply?.text ?? null,
        verdict:
          reply !== null && outcome !== null && outcome !== 'abandoned' ? verdictFrom(reply, outcome) : null,
        at: turn.at,
      }),
    );
  }
  return rounds;
}

export function capstoneStatus(node: ModuleNode | null, rounds: CapstoneSubmission[]): Capstone['status'] {
  if (node !== null && isPassedState(node.state)) return 'passed';
  return rounds.length > 0 ? 'in-review' : 'not-started';
}

export function capstoneRecord(topic: Topic, graph: ModuleGraph, session: EvalSession | null): Capstone | null {
  const node = capstoneNode(graph);
  if (node === null) return null;
  const rounds = session === null ? [] : capstoneRounds(session);
  return {
    topicId: topic.id,
    moduleId: node.id,
    spec: node.content?.explanation.kind === 'text' ? node.content.explanation.markdown : node.title,
    drivingQuestionRef: topic.drivingQuestion ?? '',
    purposeRef: topic.purpose,
    submissions: rounds,
    status: capstoneStatus(node, rounds),
  };
}

// WHY (F13 AC): the topic is not `done` until the capstone itself passes, so
// this asks the capstone node's state and never infers completion from the
// other modules being finished.
export function topicIsDone(graph: ModuleGraph): boolean {
  const node = capstoneNode(graph);
  if (node === null) return false;
  const others = graph.nodes.filter((n) => n.kind !== 'capstone');
  return isPassedState(node.state) && others.every((n) => isPassedState(n.state));
}

// WHY (F13): the review judges the submitted artefact, so the artefact text is
// what is sent — a bare "done" is refused before any session is dispatched.
export function artifactIsReviewable(artifact: string): boolean {
  const trimmed = artifact.trim();
  return trimmed.length >= 20 && Buffer.byteLength(trimmed, 'utf8') <= MAX_CAPSTONE_ARTIFACT_BYTES;
}

export function priorFeedbackDigest(rounds: CapstoneSubmission[]): string[] {
  return rounds
    .filter((r) => r.feedback !== null)
    .map((r) => `Round ${r.round} feedback: ${r.feedback as string}`);
}
