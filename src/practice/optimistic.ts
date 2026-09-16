// FRACTAL: implements F8 | component C7
import type { PracticeSession } from '@/shapes';
import type { AppError } from '@/core/errors';

export type PendingAnswer = { key: string; index: number; correct: boolean };

export type PracticeAnswerView = {
  session: PracticeSession;
  pending: PendingAnswer[];
  error: string | null;
};

export function practiceAnswerView(session: PracticeSession): PracticeAnswerView {
  return { session, pending: [], error: null };
}

export function answerKey(index: number, attempt: number): string {
  return `a${index}-${attempt}`;
}

// WHY (optimistic UI): the mark lands in the view on the same tick the learner
// clicks it — nothing here awaits the write, and the controls stay live.
export function applyOptimisticAnswer(
  view: PracticeAnswerView,
  index: number,
  correct: boolean,
): { view: PracticeAnswerView; key: string } {
  const key = answerKey(index, view.pending.length);
  const questions = view.session.questions.map((q, i) => (i === index ? { ...q, answered: true, correct } : q));
  return {
    key,
    view: {
      session: {
        ...view.session,
        questions,
        answeredCount: questions.filter((q) => q.answered).length,
      },
      pending: [...view.pending, { key, index, correct }],
      error: null,
    },
  };
}

export function settleAnswer(
  view: PracticeAnswerView,
  key: string,
  server: PracticeSession,
): PracticeAnswerView {
  return {
    session: server,
    pending: view.pending.filter((p) => p.key !== key),
    error: view.error,
  };
}

// WHY (optimistic UI): a failed write is never silently dropped — the mark is
// removed again and the learner is told, so the question reads as unanswered.
export function rollbackAnswer(
  view: PracticeAnswerView,
  key: string,
  error: AppError,
): PracticeAnswerView {
  const failed = view.pending.find((p) => p.key === key) ?? null;
  const questions =
    failed === null
      ? view.session.questions
      : view.session.questions.map((q, i) => (i === failed.index ? { ...q, answered: false, correct: null } : q));
  return {
    session: {
      ...view.session,
      questions,
      answeredCount: questions.filter((q) => q.answered).length,
    },
    pending: view.pending.filter((p) => p.key !== key),
    error: error.message,
  };
}
