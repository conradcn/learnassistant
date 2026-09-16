// FRACTAL: implements F3 | component C10
'use client';
import { useState, type FormEvent, type ReactNode } from 'react';
import type { WarmUp } from '@/shapes';
import { MathText } from '@/ui/components/MathText';
import type { WarmUpStage } from '@/ui/lesson';

export type WarmUpGateProps = {
  warmUp: WarmUp;
  stage: WarmUpStage;
  /** What the learner wrote on an earlier visit, shown back instead of re-asking. */
  savedAnswer?: string | null;
  error: string | null;
  onAttempt: (text: string) => void;
  onSkip: () => void;
};

/**
 * WHY (F3 AC): the explanation is not rendered by this component's parent until `stage`
 * leaves `not-attempted`, so a first try — or a deliberate decision not to — always comes
 * first. Neither control is ever disabled while the note is being saved.
 */
export function WarmUpGate({ warmUp, stage, savedAnswer = null, error, onAttempt, onSkip }: WarmUpGateProps): ReactNode {
  const [text, setText] = useState('');

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    onAttempt(trimmed);
  };

  return (
    <section className="la-card" data-testid="warm-up" data-stage={stage}>
      <h3>Have a go first</h3>
      <MathText as="p" testId="warm-up-prompt" text={warmUp.prompt} />
      {stage === 'not-attempted' ? (
        <form onSubmit={submit}>
          <label htmlFor="warm-up-answer">Your first thoughts — rough is fine, nothing is marked</label>
          <textarea
            id="warm-up-answer"
            data-testid="warm-up-answer"
            rows={4}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="la-row">
            <button type="submit" data-testid="warm-up-submit">
              Done thinking — show me
            </button>
            <button type="button" data-testid="warm-up-skip" onClick={onSkip}>
              Skip this and read on
            </button>
          </div>
        </form>
      ) : (
        <>
          {savedAnswer === null ? null : (
            <blockquote data-testid="warm-up-saved-answer">
              <MathText as="p" text={savedAnswer} />
            </blockquote>
          )}
          <p className="la-muted" data-testid="warm-up-settled">
            {stage === 'attempted'
              ? 'Your first thoughts are saved. Compare them with the explanation below.'
              : 'You went straight on. You can always come back to this question afterwards.'}
          </p>
        </>
      )}
      {error === null ? null : (
        <p className="la-error" role="alert" data-testid="warm-up-error">
          {error}
        </p>
      )}
    </section>
  );
}
