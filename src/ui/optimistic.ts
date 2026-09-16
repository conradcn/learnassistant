// FRACTAL: implements F3, F4, F5, F7, F8, F9, F10, F11, F13 | component C10
import type { ApiResponse, AppErrorShape, EvalTurnResult, LearnerMessage, PracticeSession } from '@/shapes';
import type { AppError } from '@/core/errors';
import {
  applyOptimisticSend,
  rollbackSend,
  settleSend,
  type ChatView,
} from '@/eval/optimistic';
import {
  applyOptimisticAnswer,
  rollbackAnswer,
  settleAnswer,
  type PracticeAnswerView,
} from '@/practice/optimistic';
import type { PendingOp, PendingOpKind } from '@/ui/shapes';

export type OptimisticHost<S> = {
  getState: () => S;
  setState: (next: S) => void;
  addPending: (op: PendingOp) => void;
  removePending: (id: string) => void;
  setError: (error: AppErrorShape | null) => void;
};

export type OptimisticOp<S, R> = {
  kind: PendingOpKind;
  apply: (state: S) => S;
  persist: () => Promise<ApiResponse<R>>;
  reconcile: (state: S, result: R) => S;
  /**
   * WHY (H12): restoring the pre-op snapshot alone throws away what the learner typed —
   * the view goes back to a state where the message was never written and nothing on
   * screen offers it back. An op that has somewhere to put the failed input supplies
   * this instead, and the plain snapshot is only the fallback for ops that do not.
   */
  rollback?: (state: S, snapshot: S, error: AppErrorShape) => S;
};

export type OpHandle = {
  id: string;
  kind: PendingOpKind;
  settled: Promise<AppErrorShape | null>;
};

let opCounter = 0;

export function nextOpId(): string {
  opCounter += 1;
  return `op_${opCounter}`;
}

export function resetOpIds(): void {
  opCounter = 0;
}

/**
 * WHY (H12): the shared error taxonomy is a class, but only its shape crosses the wire.
 * Rehydrating it here lets the C6/C7 rollback helpers be reused verbatim instead of
 * being re-implemented against a second error type.
 */
export function asAppError(shape: AppErrorShape): AppError {
  return Object.assign(new Error(shape.message), {
    name: 'AppError',
    code: shape.code,
    correlationId: shape.correlationId,
    toShape: (): AppErrorShape => shape,
  });
}

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0
    ? cause.message
    : 'That did not save. Try it again.';
}

/**
 * The whole optimistic contract in one place: `apply` runs on the calling tick, the
 * request starts afterwards, and the settle path either folds in the server's
 * authoritative result or restores the pre-op snapshot and surfaces the reason. No
 * control is ever disabled for the round trip because nothing here reports "busy".
 */
export function runOptimisticOp<S, R>(host: OptimisticHost<S>, op: OptimisticOp<S, R>): OpHandle {
  const snapshot = host.getState();
  const id = nextOpId();
  host.setError(null);
  host.setState(op.apply(snapshot));

  const rollback = (error: AppErrorShape | null): void =>
    host.setState(
      op.rollback === undefined || error === null
        ? snapshot
        : op.rollback(host.getState(), snapshot, error),
    );
  host.addPending({ id, kind: op.kind, optimisticAppliedAt: Date.now(), rollback: () => rollback(null) });

  const settled = op
    .persist()
    .then((response): AppErrorShape | null => {
      host.removePending(id);
      if (response.ok) {
        host.setState(op.reconcile(host.getState(), response.data));
        return null;
      }
      rollback(response.error);
      host.setError(response.error);
      return response.error;
    })
    .catch((cause: unknown): AppErrorShape | null => {
      host.removePending(id);
      const error: AppErrorShape = {
        code: 'internal',
        message: messageOf(cause),
        correlationId: 'c_browser',
      };
      rollback(error);
      host.setError(error);
      return error;
    });

  return { id, kind: op.kind, settled };
}

/** Reuses C6's chat view machinery rather than restating the send/rollback rules. */
export function sendMessageOp(
  message: LearnerMessage,
  persist: () => Promise<ApiResponse<EvalTurnResult>>,
): OptimisticOp<ChatView, EvalTurnResult> {
  let key = '';
  return {
    kind: 'send-message',
    apply: (view): ChatView => {
      const applied = applyOptimisticSend(view, message);
      key = applied.key;
      return applied.view;
    },
    persist,
    reconcile: (view, result): ChatView => settleSend(view, key, result),
    rollback: (view, _snapshot, error): ChatView => rollbackChat(view, key, error),
  };
}

export function rollbackChat(view: ChatView, key: string, error: AppErrorShape): ChatView {
  return rollbackSend(view, key, asAppError(error));
}

/** Reuses C7's practice view machinery for the answer/skip op. */
export function answerPracticeOp(
  index: number,
  correct: boolean,
  persist: () => Promise<ApiResponse<PracticeSession>>,
): OptimisticOp<PracticeAnswerView, PracticeSession> {
  let key = '';
  return {
    kind: 'answer-practice',
    apply: (view): PracticeAnswerView => {
      const applied = applyOptimisticAnswer(view, index, correct);
      key = applied.key;
      return applied.view;
    },
    persist,
    reconcile: (view, session): PracticeAnswerView => settleAnswer(view, key, session),
    rollback: (view, _snapshot, error): PracticeAnswerView => rollbackPractice(view, key, error),
  };
}

export function rollbackPractice(
  view: PracticeAnswerView,
  key: string,
  error: AppErrorShape,
): PracticeAnswerView {
  return rollbackAnswer(view, key, asAppError(error));
}
