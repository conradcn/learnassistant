// FRACTAL: implements F1 | component C6
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DiagnosticTranscript, DiagnosticTurnRequest, DiagnosticTurnResult, EvalTurn, TopicId } from '@/shapes';
import { err } from '@/core/errors';
import { log } from '@/core/log';
import { dispatchSession, sessionError, READ_ONLY_TOOLS, type OrchestratorDeps } from '@/orchestrator/session';
import { newModuleId, nowIso } from '@/orchestrator/ids';
import type { ModuleBrief } from '@/cli/prompt';

export const DIAGNOSTIC_TIMEOUT_MS = 90 * 1000;
/** features.md scale: diagnostic exchanges = 5. After the fifth answer it ends on its own. */
export const MAX_DIAGNOSTIC_EXCHANGES = 5;

const diagnosticOutputSchema = z.object({
  question: z.string().nullable(),
  priorKnowledge: z.array(z.string()),
});

export const DIAGNOSTIC_SILENT_MESSAGE =
  'Your tutor did not come back with a question. Nothing was lost — send it again, or skip ahead.';

function turn(role: EvalTurn['role'], text: string): EvalTurn {
  return { id: randomUUID(), role, text, assistLevel: null, angle: null, mode: 'question', selfAssessment: null, at: nowIso() };
}

/** The question the transcript is waiting on: an evaluator turn nobody has answered yet. */
export function pendingQuestion(transcript: DiagnosticTranscript): string | null {
  const last = transcript.exchanges.at(-1);
  return last !== undefined && last.role === 'evaluator' ? last.text : null;
}

function answeredCount(transcript: DiagnosticTranscript): number {
  return transcript.exchanges.filter((t) => t.role === 'learner').length;
}

/**
 * Runs one step of the intake diagnostic (F1) and saves the transcript.
 *
 * WHY it is held after the topic exists and not inside the form: a session needs a folder
 * to run in, and a topic folder is only made once there is a topic. The planner reads
 * `priorKnowledge` off the row, so what matters is that this lands before "Plan the lessons".
 */
export async function diagnosticTurn(
  deps: OrchestratorDeps,
  topicId: TopicId,
  request: DiagnosticTurnRequest,
  signal: AbortSignal = new AbortController().signal,
): Promise<DiagnosticTurnResult> {
  const topic = deps.store.topics.get(topicId);
  if (topic === null || 'degraded' in topic) {
    throw err('not-found', { detail: 'diagnostic for an unknown topic', userMessage: 'We could not find that subject.' });
  }
  const current: DiagnosticTranscript = topic.diagnostic ?? { skipped: false, exchanges: [], priorKnowledge: [] };

  if (request.skip) {
    const skipped = { ...current, skipped: current.exchanges.length === 0 };
    // Drop a question nobody answered: it tells the planner nothing.
    if (pendingQuestion(skipped) !== null) skipped.exchanges = skipped.exchanges.slice(0, -1);
    deps.store.topics.setDiagnostic(topicId, skipped);
    return { transcript: skipped, question: null };
  }

  const pending = pendingQuestion(current);
  const answer = request.answer ?? '';
  if (pending !== null && answer.length === 0) {
    // Nothing new to say: hand back the question already waiting rather than spend a turn.
    return { transcript: current, question: pending };
  }
  const exchanges = pending !== null ? [...current.exchanges, turn('learner', answer)] : current.exchanges;
  const draft: DiagnosticTranscript = { ...current, exchanges };

  const last = answeredCount(draft) >= MAX_DIAGNOSTIC_EXCHANGES;
  return finish(deps, topicId, draft, await ask(deps, topic, draft, signal, last));
}

async function ask(
  deps: OrchestratorDeps,
  topic: Parameters<typeof briefFor>[0],
  transcript: DiagnosticTranscript,
  signal: AbortSignal,
  last: boolean,
): Promise<z.infer<typeof diagnosticOutputSchema>> {
  const outcome = await dispatchSession(deps, {
    kind: 'diagnostic',
    topicId: topic.id,
    workspaceModuleId: newModuleId(),
    ephemeralWorkspace: true,
    brief: briefFor(topic, transcript, last),
    outputSchema: diagnosticOutputSchema,
    timeoutMs: DIAGNOSTIC_TIMEOUT_MS,
    maxTurns: 1,
    allowedTools: READ_ONLY_TOOLS,
    signal,
  });
  if (!outcome.ok) throw sessionError(outcome);
  const parsed = diagnosticOutputSchema.safeParse(outcome.output);
  if (!parsed.success) {
    throw err('cli-failed', { detail: 'diagnostic session returned an unusable turn', userMessage: DIAGNOSTIC_SILENT_MESSAGE });
  }
  return last ? { ...parsed.data, question: null } : parsed.data;
}

function briefFor(
  topic: { id: TopicId; subject: string; level: ModuleBrief['level']; levelDetail?: string; purpose: string },
  transcript: DiagnosticTranscript,
  last: boolean,
): ModuleBrief {
  // WHY (sink): the learner's words reach the model only as fenced list items.
  return {
    topicSubject: topic.subject,
    level: topic.level,
    levelDetail: topic.levelDetail ?? null,
    purpose: topic.purpose,
    drivingQuestion: '',
    moduleTitle: 'What the learner already knows',
    moduleObjectives: [
      `Ask at most ${MAX_DIAGNOSTIC_EXCHANGES} questions in all.`,
      ...(last ? ['That limit is reached: return "question": null and your final priorKnowledge list.'] : []),
    ],
    prerequisiteSummaries: [],
    downstreamSummaries: [],
    priorKnowledge: transcript.exchanges.map((t) =>
      t.role === 'evaluator' ? `You asked: ${t.text}` : `Learner answered: ${t.text}`,
    ),
    targetMinutes: 5,
  };
}

function finish(
  deps: OrchestratorDeps,
  topicId: TopicId,
  draft: DiagnosticTranscript,
  output: z.infer<typeof diagnosticOutputSchema>,
): DiagnosticTurnResult {
  const question = output.question !== null && output.question.trim().length > 0 ? output.question.trim() : null;
  const transcript: DiagnosticTranscript = {
    skipped: false,
    exchanges: question === null ? draft.exchanges : [...draft.exchanges, turn('evaluator', question)],
    priorKnowledge: output.priorKnowledge.map((k) => k.trim()).filter((k) => k.length > 0),
  };
  deps.store.topics.setDiagnostic(topicId, transcript);
  log({ level: 'info', event: 'diagnostic-turn', component: 'C6', topicId, done: question === null });
  return { transcript, question };
}
