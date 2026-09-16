// FRACTAL: implements F4 | component C10
'use client';
import type { ReactNode } from 'react';
import type { EvalTurn } from '@/shapes';
import { Markdown } from '@/ui/components/Markdown';

export const ROLE_LABEL: Record<EvalTurn['role'], string> = {
  learner: 'You',
  evaluator: 'Your tutor',
};

export type ChatTurnProps = {
  role: EvalTurn['role'];
  text: string;
  label?: string;
  testId?: string;
};

/**
 * WHY one component for both transcripts: the live conversation and the finished one the
 * learner comes back to are the same turns read twice. The finished branch used to render
 * the text as a bare node, so a reply the model wrote as markdown with $…$ in it came back
 * on the second visit as literal ##, - and raw LaTeX collapsed into one paragraph. Sharing
 * the row makes drifting apart again impossible rather than merely unlikely.
 */
export function ChatTurn({ role, text, label, testId }: ChatTurnProps): ReactNode {
  return (
    <li className="la-card" data-testid={testId ?? `chat-turn-${role}`}>
      <p className="la-muted">{label ?? ROLE_LABEL[role]}</p>
      <Markdown markdown={text} />
    </li>
  );
}
