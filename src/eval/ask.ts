// FRACTAL: implements F3 | component C6
import { z } from 'zod';
import type { LessonQuestion, ModuleId } from '@/shapes';
import { err } from '@/core/errors';
import { log } from '@/core/log';
import type { Store } from '@/store/open';
import { dispatchSession, sessionError, READ_ONLY_TOOLS, type OrchestratorDeps } from '@/orchestrator/session';
import type { ModuleBrief } from '@/cli/prompt';
import { locate } from '@/review/locate';
import { taughtScope } from '@/eval/scope';
import { lessonQuestionNote, lessonQuestionsFor } from '@/reflect/lesson-questions';
import { saveReflection } from '@/reflect/journal';

export const ASK_TIMEOUT_MS = 90 * 1000;
export const MAX_QUESTION_CHARS = 1000;
/** How much of the learner's own back-and-forth on this lesson the model is given. */
export const MAX_PRIOR_QUESTIONS = 6;

const askOutputSchema = z.object({ answer: z.string().min(1) });

export const ASK_EMPTY_MESSAGE = 'Ask a question first, then send it.';
export const ASK_SILENT_MESSAGE =
  'Your tutor did not answer that one. Nothing was lost — send it again.';

function priorLines(store: Store, topicId: Parameters<typeof lessonQuestionsFor>[1], moduleId: ModuleId): string[] {
  const asked = lessonQuestionsFor(store, topicId, moduleId).slice(-MAX_PRIOR_QUESTIONS);
  return asked.flatMap((q) => [`Learner asked: ${q.question}`, `You answered: ${q.answer}`]);
}

/**
 * Answers one question the learner asked while reading a lesson.
 *
 * WHY it is not an evaluation turn (F3): this is a hand raised mid-lesson. It is ungraded,
 * it opens no session, it touches no completion state and it can be asked before the
 * learner has done anything at all — the only thing it shares with F4 is that a model
 * answers. What bounds it is the same `taughtScope` the evaluator is bounded by, so the
 * answer is about the lesson on the page rather than the subject at large.
 */
export async function askAboutLesson(
  deps: OrchestratorDeps,
  moduleId: ModuleId,
  question: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<LessonQuestion> {
  const text = question.trim();
  if (text.length === 0) {
    throw err('validation', { detail: 'empty lesson question', userMessage: ASK_EMPTY_MESSAGE });
  }
  const asked = text.slice(0, MAX_QUESTION_CHARS);

  const located = locate(deps.store, moduleId);
  if (located === null) {
    throw err('not-found', {
      detail: 'lesson question asked about an unknown module',
      userMessage: 'We could not find that lesson.',
    });
  }
  const { topic, node } = located;
  const scope = taughtScope(node);

  // WHY (sink): the learner's words reach the model only as a fenced list item, exactly as
  // a chat turn does. Nothing typed here is concatenated into an instruction line.
  const brief: ModuleBrief = {
    topicSubject: topic.subject,
    level: topic.level,
    levelDetail: topic.levelDetail ?? null,
    purpose: topic.purpose,
    drivingQuestion: topic.drivingQuestion ?? '',
    moduleTitle: node.title,
    moduleObjectives: [
      'Answer the question below for this learner, at this level, about this lesson.',
      ...(scope.length === 0
        ? ['This lesson has not been written yet, so answer from its title and objectives alone, and say that you are.']
        : []),
    ],
    prerequisiteSummaries: [],
    downstreamSummaries: [],
    taughtContent: scope.length === 0 ? undefined : scope,
    priorKnowledge: [...priorLines(deps.store, topic.id, moduleId), `Learner asks: ${asked}`],
    targetMinutes: node.estimatedMinutes,
  };

  const outcome = await dispatchSession(deps, {
    kind: 'ask',
    topicId: topic.id,
    workspaceModuleId: moduleId,
    brief,
    outputSchema: askOutputSchema,
    timeoutMs: ASK_TIMEOUT_MS,
    maxTurns: 1,
    allowedTools: READ_ONLY_TOOLS,
    signal,
  });
  if (!outcome.ok) throw sessionError(outcome);

  const parsed = askOutputSchema.safeParse(outcome.output);
  if (!parsed.success) {
    throw err('cli-failed', { detail: 'ask session returned an unusable answer', userMessage: ASK_SILENT_MESSAGE });
  }
  const exchange: LessonQuestion = { question: asked, answer: parsed.data.answer };

  // WHY the write does not fail the answer: the learner has their answer the moment this
  // returns, and losing the note only costs them the copy on their next visit. Refusing to
  // hand back an answer that was already paid for would be the larger loss.
  try {
    saveReflection(deps.store, {
      topicId: topic.id,
      moduleId,
      text: lessonQuestionNote(exchange.question, exchange.answer),
    });
  } catch (e) {
    log({
      level: 'warn',
      event: 'lesson-question-note-failed',
      component: 'C6',
      moduleId,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  log({ level: 'info', event: 'lesson-question-answered', component: 'C6', moduleId, topicId: topic.id });
  return exchange;
}
