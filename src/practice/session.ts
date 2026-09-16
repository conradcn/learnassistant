// FRACTAL: implements F8, F7 | component C7
import { randomBytes } from 'node:crypto';
import { sessionIdSchema, type ISODateString, type PracticeSession, type SessionId } from '@/shapes';
import { err, AppError } from '@/core/errors';
import { log } from '@/core/log';
import { nowIso } from '@/orchestrator/ids';
import { isPassedState } from '@/graph/availability';
import type { Store } from '@/store/open';
import { defaultScript } from '@/eval/session';
import { rewordedQuestion } from '@/review/question';
import { recordReview } from '@/review/schedule';
import { mix, toQuestions, type MixPlan, type PracticeCandidate } from '@/practice/mix';
import type { PracticeStore } from '@/practice/store';

export const DEFAULT_PRACTICE_SIZE = 8;
export const MAX_PRACTICE_SIZE = 15;
export const NOTHING_COMPLETED_MESSAGE =
  'Nothing to practise yet — finish a lesson and it will start showing up here.';
export const PRACTICE_LOAD_FAILED_MESSAGE = 'Could not load practice just now. Try again in a moment.';

export type PracticeDeps = { store: Store; practice: PracticeStore };

export type StartedPractice = { session: PracticeSession; plan: MixPlan };

export type PracticeView =
  | { kind: 'ready'; session: PracticeSession; plan: MixPlan }
  | { kind: 'empty'; message: string }
  | { kind: 'failed'; message: string };

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function newPracticeSessionId(): SessionId {
  let out = '';
  for (const b of randomBytes(16)) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return sessionIdSchema.parse(`s_${out}`);
}

export function candidates(store: Store, now: ISODateString = nowIso()): PracticeCandidate[] {
  const dueBy = new Map<string, ISODateString>();
  for (const item of store.reviews.due(now, MAX_PRACTICE_SIZE * 40)) dueBy.set(item.moduleId, item.dueAt);
  const out: PracticeCandidate[] = [];
  for (const row of store.topics.list()) {
    if ('degraded' in row) continue;
    for (const node of store.modules.graph(row.id).nodes) {
      if (!isPassedState(node.state)) continue;
      const script = node.content?.evalScript ?? defaultScript(node.title);
      out.push({
        moduleId: node.id,
        topicId: row.id,
        moduleTitle: node.title,
        question: rewordedQuestion(script, node.title, node.ordinal),
        due: dueBy.has(node.id),
        dueAt: dueBy.get(node.id) ?? null,
      });
    }
  }
  return out;
}

export function startPractice(
  deps: PracticeDeps,
  size: number = DEFAULT_PRACTICE_SIZE,
  now: ISODateString = nowIso(),
): StartedPractice {
  const bounded = Math.min(MAX_PRACTICE_SIZE, Math.max(1, Math.floor(size)));
  const pool = candidates(deps.store, now);
  if (pool.length === 0) {
    throw err('conflict', {
      detail: 'practice requested with zero completed modules',
      userMessage: NOTHING_COMPLETED_MESSAGE,
    });
  }
  const { plan, picks } = mix(pool, bounded);
  const session = deps.practice.save({
    id: newPracticeSessionId(),
    questions: toQuestions(picks),
    answeredCount: 0,
    stoppedEarly: false,
  });
  log({
    level: 'info',
    event: 'practice-started',
    component: 'C7',
    sessionId: session.id,
    questions: session.questions.length,
    topics: plan.perTopic.length,
  });
  return { session, plan };
}

// WHY (H3): "nothing completed yet" and "we could not read your data" are
// different states — the empty one is a normal place to be, the failed one is
// something gone wrong, and the learner is told which.
export function practiceView(
  deps: PracticeDeps,
  size: number = DEFAULT_PRACTICE_SIZE,
  now: ISODateString = nowIso(),
): PracticeView {
  try {
    const started = startPractice(deps, size, now);
    return { kind: 'ready', session: started.session, plan: started.plan };
  } catch (e) {
    if (e instanceof AppError && e.code === 'conflict') {
      return { kind: 'empty', message: NOTHING_COMPLETED_MESSAGE };
    }
    if (e instanceof AppError) {
      return { kind: 'failed', message: e.message };
    }
    const wrapped = err('internal', {
      detail: e instanceof Error ? e.message : String(e),
      userMessage: PRACTICE_LOAD_FAILED_MESSAGE,
    });
    return { kind: 'failed', message: wrapped.message };
  }
}

function openSession(deps: PracticeDeps, sessionId: SessionId): PracticeSession {
  const session = deps.practice.get(sessionId);
  if (session === null) {
    throw err('not-found', {
      detail: 'practice session id is not open',
      userMessage: 'That practice session is no longer open. Start a new one whenever you like.',
    });
  }
  return session;
}

export function answerPractice(
  deps: PracticeDeps,
  sessionId: SessionId,
  index: number,
  correct: boolean,
  now: ISODateString = nowIso(),
): PracticeSession {
  const session = openSession(deps, sessionId);
  if (!Number.isInteger(index) || index < 0 || index >= session.questions.length) {
    throw err('validation', {
      detail: 'practice answer index out of range',
      userMessage: 'That question is not part of this practice session.',
    });
  }
  const question = session.questions[index];
  if (question.answered) {
    throw err('conflict', {
      detail: 'practice question answered twice',
      userMessage: 'You already answered that one.',
    });
  }
  const questions = session.questions.map((q, i) => (i === index ? { ...q, answered: true, correct } : q));
  const next = deps.practice.save({
    ...session,
    questions,
    answeredCount: questions.filter((q) => q.answered).length,
  });
  // WHY (F7 x F8): a practice answer IS a retrieval attempt, so it moves the
  // same schedule a standalone review would.
  if (deps.store.reviews.get(question.moduleId) !== null) {
    recordReview(deps.store, question.moduleId, correct, now);
  }
  return next;
}

// WHY (F8 AC): stopping keeps everything already answered — each answer was
// written as it happened, so stopping only records that the learner stopped.
export function stopPractice(deps: PracticeDeps, sessionId: SessionId): PracticeSession {
  const session = openSession(deps, sessionId);
  const stopped = deps.practice.save({ ...session, stoppedEarly: true });
  log({
    level: 'info',
    event: 'practice-stopped',
    component: 'C7',
    sessionId,
    answered: stopped.answeredCount,
    total: stopped.questions.length,
  });
  return stopped;
}
