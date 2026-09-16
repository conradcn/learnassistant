// FRACTAL: covers F3, F4, F5, F7, F8, F9, F10, F11, F13 | type unit
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiResponse, AppErrorShape, EvalTurnResult, PracticeSession } from '@/shapes';
import { exampleEvalTurnResult, examplePracticeQuestion, examplePracticeSession } from '@/shapes';
import { EMPTY_CHAT, type ChatView } from '@/eval/optimistic';
import { practiceAnswerView } from '@/practice/optimistic';
import {
  answerPracticeOp,
  resetOpIds,
  rollbackChat,
  rollbackPractice,
  runOptimisticOp,
  sendMessageOp,
  type OptimisticHost,
} from '@/ui/optimistic';
import type { PendingOp, PendingOpKind } from '@/ui/shapes';

type Board = { items: string[]; controlEnabled: boolean };

type Harness<S> = {
  host: OptimisticHost<S>;
  states: S[];
  pending: PendingOp[];
  errors: (AppErrorShape | null)[];
};

function harness<S>(initial: S): Harness<S> {
  let current = initial;
  const h: Harness<S> = {
    states: [],
    pending: [],
    errors: [],
    host: {
      getState: () => current,
      setState: (next): void => {
        current = next;
        h.states.push(next);
      },
      addPending: (op): void => {
        h.pending.push(op);
      },
      removePending: (id): void => {
        h.pending = h.pending.filter((op) => op.id !== id);
      },
      setError: (error): void => {
        h.errors.push(error);
      },
    },
  };
  return h;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const FAILURE: AppErrorShape = {
  code: 'internal',
  message: 'That change did not save. Try it again.',
  correlationId: 'c_1',
};

const SESSION_WITH_QUESTION: PracticeSession = {
  ...examplePracticeSession,
  questions: [examplePracticeQuestion],
};

const ALL_KINDS: PendingOpKind[] = [
  'send-message',
  'complete-module',
  'save-reflection',
  'record-prediction',
  'answer-practice',
  'record-review',
];

beforeEach(resetOpIds);

describe('optimistic operations', () => {
  it('applies the change on the same tick, before the request settles', () => {
    const h = harness<Board>({ items: [], controlEnabled: true });
    const gate = deferred<ApiResponse<string[]>>();

    runOptimisticOp(h.host, {
      kind: 'complete-module',
      apply: (state) => ({ ...state, items: [...state.items, 'entropy'] }),
      persist: () => gate.promise,
      reconcile: (state, server) => ({ ...state, items: server }),
    });

    expect(h.host.getState().items).toEqual(['entropy']);
    expect(h.pending.map((op) => op.kind)).toEqual(['complete-module']);
    gate.resolve({ ok: true, data: ['entropy'] });
  });

  it('never disables the control for the round trip', async () => {
    const h = harness<Board>({ items: [], controlEnabled: true });
    const gate = deferred<ApiResponse<string[]>>();

    const handle = runOptimisticOp(h.host, {
      kind: 'record-prediction',
      apply: (state) => ({ ...state, items: ['predicted'] }),
      persist: () => gate.promise,
      reconcile: (state, server) => ({ ...state, items: server }),
    });

    expect(h.host.getState().controlEnabled).toBe(true);
    gate.resolve({ ok: true, data: ['predicted'] });
    await handle.settled;
    expect(h.states.every((state) => state.controlEnabled)).toBe(true);
  });

  it('folds in the server-authoritative result on success and clears the pending op', async () => {
    const h = harness<Board>({ items: [], controlEnabled: true });
    const handle = runOptimisticOp(h.host, {
      kind: 'save-reflection',
      apply: (state) => ({ ...state, items: ['my note'] }),
      persist: () => Promise.resolve<ApiResponse<string[]>>({ ok: true, data: ['my note (saved)'] }),
      reconcile: (state, server) => ({ ...state, items: server }),
    });

    expect(await handle.settled).toBeNull();
    expect(h.host.getState().items).toEqual(['my note (saved)']);
    expect(h.pending).toHaveLength(0);
  });

  it.each(ALL_KINDS)('rolls %s back and surfaces the reason when the write fails', async (kind) => {
    const h = harness<Board>({ items: ['before'], controlEnabled: true });
    const handle = runOptimisticOp(h.host, {
      kind,
      apply: (state) => ({ ...state, items: [...state.items, 'after'] }),
      persist: () => Promise.resolve<ApiResponse<string[]>>({ ok: false, error: FAILURE }),
      reconcile: (state, server) => ({ ...state, items: server }),
    });

    expect(h.host.getState().items).toEqual(['before', 'after']);
    const settled = await handle.settled;
    expect(settled).toEqual(FAILURE);
    expect(h.host.getState().items).toEqual(['before']);
    expect(h.host.getState().controlEnabled).toBe(true);
    expect(h.errors.at(-1)).toEqual(FAILURE);
    expect(h.pending).toHaveLength(0);
  });

  it('never silently drops a write that threw instead of resolving', async () => {
    const h = harness<Board>({ items: ['before'], controlEnabled: true });
    const handle = runOptimisticOp(h.host, {
      kind: 'record-review',
      apply: (state) => ({ ...state, items: ['optimistic'] }),
      persist: () => Promise.reject(new Error('That did not save. Try it again.')),
      reconcile: (state) => state,
    });

    const settled = await handle.settled;
    expect(settled?.message).toBe('That did not save. Try it again.');
    expect(h.host.getState().items).toEqual(['before']);
    expect(h.pending).toHaveLength(0);
  });

  it('exposes a rollback on the pending op that restores the pre-op state', () => {
    const h = harness<Board>({ items: ['before'], controlEnabled: true });
    const gate = deferred<ApiResponse<string[]>>();
    runOptimisticOp(h.host, {
      kind: 'record-review',
      apply: (state) => ({ ...state, items: ['after'] }),
      persist: () => gate.promise,
      reconcile: (state) => state,
    });

    h.pending[0].rollback();
    expect(h.host.getState().items).toEqual(['before']);
    gate.resolve({ ok: true, data: ['after'] });
  });

  it('clears the composer and keeps it enabled the moment a message is sent (F4/F9/F13)', async () => {
    const h = harness<ChatView>({ ...EMPTY_CHAT, composer: { text: 'my answer', enabled: true, error: null } });
    const handle = runOptimisticOp(
      h.host,
      sendMessageOp({ text: 'my answer', selfAssessment: null }, () =>
        Promise.resolve<ApiResponse<EvalTurnResult>>({ ok: true, data: exampleEvalTurnResult }),
      ),
    );

    expect(h.host.getState().composer.text).toBe('');
    expect(h.host.getState().composer.enabled).toBe(true);
    expect(h.host.getState().pending).toHaveLength(1);

    expect(await handle.settled).toBeNull();
    expect(h.host.getState().turns).toEqual(exampleEvalTurnResult.session.turns);
    expect(h.host.getState().pending).toHaveLength(0);
  });

  it('puts a failed message back in the composer with the reason', () => {
    const applied = { ...EMPTY_CHAT, composer: { text: 'my answer', enabled: true, error: null } };
    const sent = sendMessageOp({ text: 'my answer', selfAssessment: null }, () =>
      Promise.resolve<ApiResponse<EvalTurnResult>>({ ok: false, error: FAILURE }),
    ).apply(applied);

    const rolledBack = rollbackChat(sent, sent.pending[0].key, FAILURE);
    expect(rolledBack.composer.text).toBe('my answer');
    expect(rolledBack.composer.enabled).toBe(true);
    expect(rolledBack.composer.error).toBe(FAILURE.message);
    expect(rolledBack.pending).toHaveLength(0);
  });

  it('marks a practice answer immediately and reconciles against the server session (F8)', async () => {
    const h = harness(practiceAnswerView(SESSION_WITH_QUESTION));
    const server: PracticeSession = {
      ...SESSION_WITH_QUESTION,
      questions: SESSION_WITH_QUESTION.questions.map((q, i) => (i === 0 ? { ...q, answered: true, correct: true } : q)),
      answeredCount: 1,
    };
    const handle = runOptimisticOp(
      h.host,
      answerPracticeOp(0, true, () => Promise.resolve<ApiResponse<PracticeSession>>({ ok: true, data: server })),
    );

    expect(h.host.getState().session.questions[0].answered).toBe(true);
    expect(await handle.settled).toBeNull();
    expect(h.host.getState().session).toEqual(server);
  });

  it('unmarks a practice answer and names the problem when the write fails', () => {
    const applied = answerPracticeOp(0, true, () =>
      Promise.resolve<ApiResponse<PracticeSession>>({ ok: false, error: FAILURE }),
    ).apply(practiceAnswerView(SESSION_WITH_QUESTION));

    const rolledBack = rollbackPractice(applied, applied.pending[0].key, FAILURE);
    expect(rolledBack.session.questions[0].answered).toBe(false);
    expect(rolledBack.error).toBe(FAILURE.message);
  });
});
