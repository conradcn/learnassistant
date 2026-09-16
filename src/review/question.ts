// FRACTAL: implements F7 | component C7
import { z } from 'zod';
import type { EvalScript, EvalSession, ModuleId } from '@/shapes';
import { err } from '@/core/errors';
import { log } from '@/core/log';
import { nowIso } from '@/orchestrator/ids';
import { dispatchSession, sessionError, READ_ONLY_TOOLS, type OrchestratorDeps } from '@/orchestrator/session';
import type { ModuleBrief } from '@/cli/prompt';
import { defaultScript, openingSeed, sessionIdFor, type EvalEngine } from '@/eval/session';
import { evaluatorTurnId } from '@/eval/turn-id';
import { reflectionQuoteForReview } from '@/reflect/journal';
import { locate, type LocatedModule } from '@/review/locate';
import { scopeInstructions, taughtScope } from '@/eval/scope';

export const REVIEW_QUESTION_TIMEOUT_MS = 120 * 1000;
export const REVIEW_QUESTION_MAX_TURNS = 4;
export const REVIEW_PREPARE_FAILED_MESSAGE =
  'Could not prepare this review. It stays in your queue â€” try again whenever you like.';

export const reviewQuestionOutputSchema = z
  .object({ question: z.string().min(8).max(2000) })
  .passthrough();

export type ReviewDeps = OrchestratorDeps & { engine: EvalEngine };

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// WHY (F7 AC): "reworded, not repeated" has to be checkable, so verbatim means
// exactly this â€” same words, ignoring case, spacing and punctuation.
export function isVerbatimRepeat(candidate: string, priorQuestions: string[]): boolean {
  const target = normalize(candidate);
  return priorQuestions.some((p) => normalize(p) === target);
}

export function priorQuestionsFor(script: EvalScript, session: EvalSession | null): string[] {
  const fromTranscript = (session?.turns ?? []).filter((t) => t.role === 'evaluator').map((t) => t.text);
  return [...script.seedQuestions, ...fromTranscript];
}

// WHY: `objectives` and `angles` are notes to the evaluator — prompt.ts says in so many
// words that they are never shown — and they are written as instructions about the learner
// ("Show you can use the ideas in X"). Splicing them into a sentence addressed to the
// learner puts an LLM prompt where a question to a person belongs, which is what practice
// was showing on every card. So the question is built from the seed instead: the seed is
// the one field authoring writes for the learner, and openingSeed has already re-addressed
// it if it came out as a stage direction.
const REWORD_FRAMES: ((seed: string) => string)[] = [
  (seed) => `Here is a fresh case to work through. ${seed}

Show the reasoning, not just the conclusion.`,
  (seed) => `Same idea, new situation. ${seed}

Walk me through how you get there.`,
  (seed) =>
    `Suppose you had to talk someone else through this. ${seed}

Start from what they would need to know first.`,
];

// WHY it is never a bare seed: this is what a learner sees weeks after the lesson, and F7
// asks for reworded rather than repeated. The frame is what carries the rewording.
export function rewordedQuestion(script: EvalScript, moduleTitle: string, salt: number): string {
  const seed = openingSeed(script, defaultScript(moduleTitle));
  return REWORD_FRAMES[salt % REWORD_FRAMES.length](seed.trim());
}

// WHY the scope is here too: a review question is the same gate as the lesson-end one,
// asked weeks later, and it had the same hole — objectives and pass criteria but never the
// lesson. A question drifting onto material the module did not teach is worse here than at
// the end of the lesson, because the learner has no page in front of them to check it
// against and reads the miss as forgetting.
export function reviewBrief(located: LocatedModule, script: EvalScript, reflectionQuote: string | null): ModuleBrief {
  const scope = taughtScope(located.node);
  const priorKnowledge = [
    ...script.passCriteria.map((c) => `Pass criterion: ${c}`),
    ...(reflectionQuote === null ? [] : [`The learner's own words about this lesson: ${reflectionQuote}`]),
  ];
  return {
    topicSubject: located.topic.subject,
    level: located.topic.level,
    levelDetail: located.topic.levelDetail ?? null,
    purpose: located.topic.purpose,
    drivingQuestion: located.topic.drivingQuestion ?? '',
    moduleTitle: located.node.title,
    moduleObjectives: [...scopeInstructions(scope), ...script.objectives.map((o) => `Objective: ${o}`)],
    prerequisiteSummaries: [],
    downstreamSummaries: [],
    priorKnowledge,
    taughtContent: scope.length === 0 ? undefined : scope,
    targetMinutes: 5,
  };
}

export async function generateReviewQuestion(
  deps: ReviewDeps,
  moduleId: ModuleId,
  signal: AbortSignal = new AbortController().signal,
): Promise<string> {
  const located = locate(deps.store, moduleId);
  if (located === null) {
    throw err('not-found', {
      detail: 'review question requested for a module that no longer exists',
      userMessage: 'We could not find that lesson.',
    });
  }
  const script = located.node.content?.evalScript ?? defaultScript(located.node.title);
  const existing = deps.store.evals.get(sessionIdFor('review', { kind: 'review', moduleId }));
  const prior = priorQuestionsFor(script, existing);
  const salt = prior.length;
  const fallback = rewordedQuestion(script, located.node.title, salt);
  const reflectionQuote = reflectionQuoteForReview(deps.store, located.topic.id, moduleId);

  const outcome = await dispatchSession(deps, {
    kind: 'review-question',
    topicId: located.topic.id,
    workspaceModuleId: moduleId,
    brief: reviewBrief(located, script, reflectionQuote),
    outputSchema: reviewQuestionOutputSchema,
    timeoutMs: REVIEW_QUESTION_TIMEOUT_MS,
    maxTurns: REVIEW_QUESTION_MAX_TURNS,
    allowedTools: READ_ONLY_TOOLS,
    signal,
  });

  if (!outcome.ok) {
    log({ level: 'warn', event: 'review-question-failed', component: 'C7', moduleId, code: outcome.code });
    throw err(sessionError(outcome).code, {
      detail: `review question generation failed: ${outcome.code}`,
      userMessage: REVIEW_PREPARE_FAILED_MESSAGE,
    });
  }

  const parsed = reviewQuestionOutputSchema.safeParse(outcome.output);
  if (!parsed.success) {
    log({ level: 'warn', event: 'review-question-unusable', component: 'C7', moduleId });
    return fallback;
  }
  if (isVerbatimRepeat(parsed.data.question, prior)) {
    log({ level: 'warn', event: 'review-question-verbatim', component: 'C7', moduleId });
    return fallback;
  }
  return parsed.data.question;
}

// WHY: the card shows the question the learner is being asked right now, which
// is the newest evaluator question — that is the one the "never verbatim" rule
// is about.
export function reviewQuestionOf(session: EvalSession): string {
  const questions = session.turns.filter((t) => t.role === 'evaluator' && t.mode === 'question');
  const last = questions[questions.length - 1];
  return last === undefined ? '' : last.text;
}

export async function startReview(
  deps: ReviewDeps,
  moduleId: ModuleId,
  signal: AbortSignal = new AbortController().signal,
): Promise<EvalSession> {
  const question = await generateReviewQuestion(deps, moduleId, signal);
  const session = deps.engine.open('review', { kind: 'review', moduleId });
  const last = session.turns[session.turns.length - 1];
  if (last !== undefined && normalize(last.text) === normalize(question)) return session;
  deps.store.evals.append(session.id, {
    id: evaluatorTurnId(session.turns.length, 'continue'),
    role: 'evaluator',
    text: question,
    assistLevel: 0,
    angle: null,
    mode: 'question',
    selfAssessment: null,
    at: nowIso(),
  });
  return deps.engine.resume(session.id);
}
