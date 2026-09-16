// FRACTAL: implements F4 | component C6
import type { EvalTurn, EvalTurnResult, LearnerMessage, SelfAssessment } from '@/shapes';
import type { AppError } from '@/core/errors';

export type PendingMessage = {
  key: string;
  text: string;
  selfAssessment: SelfAssessment | null;
  state: 'sending' | 'failed';
};

export type ComposerView = {
  text: string;
  enabled: boolean;
  error: string | null;
};

export type ChatView = {
  turns: EvalTurn[];
  pending: PendingMessage[];
  composer: ComposerView;
};

export const EMPTY_CHAT: ChatView = {
  turns: [],
  pending: [],
  composer: { text: '', enabled: true, error: null },
};

// WHY (F4 invariant): while the conversation is open, a transcript whose last word is the
// learner's is one waiting on a reply that is not coming — the turn was interrupted after
// the message was saved. The view has to be able to tell that apart from "your move", or it
// draws a composer under a question the tutor never answered and waits for the learner to
// notice.
export function awaitsReply(turns: EvalTurn[]): boolean {
  const last = turns[turns.length - 1];
  return last !== undefined && last.role === 'learner';
}

function keyFor(view: ChatView): string {
  return `p${view.turns.length}-${view.pending.length}`;
}

// WHY (optimistic UI): the learner's message is placed in the transcript and the
// composer is cleared and left enabled on the same tick the send is triggered —
// nothing here awaits the round trip, so a fast second message still lands.
export function applyOptimisticSend(view: ChatView, message: LearnerMessage): { view: ChatView; key: string } {
  const key = keyFor(view);
  return {
    key,
    view: {
      turns: view.turns,
      pending: [
        ...view.pending,
        { key, text: message.text, selfAssessment: message.selfAssessment, state: 'sending' },
      ],
      composer: { text: '', enabled: true, error: null },
    },
  };
}

export function settleSend(view: ChatView, key: string, result: EvalTurnResult): ChatView {
  return {
    turns: result.session.turns,
    pending: view.pending.filter((p) => p.key !== key),
    composer: view.composer,
  };
}

// WHY (optimistic UI): a failed write is never dropped — the text goes back into
// the composer so the learner can retry without retyping, and the reason is
// shown in the learner's own words.
export function rollbackSend(view: ChatView, key: string, error: AppError): ChatView {
  const failed = view.pending.find((p) => p.key === key) ?? null;
  return {
    turns: view.turns,
    pending: view.pending.filter((p) => p.key !== key),
    composer: {
      text: failed === null ? view.composer.text : failed.text,
      enabled: true,
      error: error.message,
    },
  };
}
