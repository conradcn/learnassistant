// FRACTAL: implements F7 | component C10
'use client';
import { useState, type ReactNode } from 'react';
import type { ModuleId } from '@/shapes';
import { recordReview } from '@/ui/api-client';
import { MathText } from '@/ui/components/MathText';
import {
  MISSED_LABEL,
  outcomeLine,
  queueHeader,
  REMEMBERED_LABEL,
  REVIEW_INTRO,
  REVIEW_OPEN_LABEL,
  type ReviewCardView,
} from '@/ui/review-copy';

export type ReviewQueueProps = {
  cards: readonly ReviewCardView[];
  dueTotal: number;
};

type Marks = Record<string, boolean>;

/**
 * WHY (F7 AC): this is a list of optional cards, never a dialog and never a gate. Nothing
 * on the page is blocked by leaving a card untouched, and recording an outcome lands on
 * the same tick the learner clicks it.
 */
export function ReviewQueue({ cards, dueTotal }: ReviewQueueProps): ReactNode {
  const [marks, setMarks] = useState<Marks>({});
  const [error, setError] = useState<string | null>(null);

  const record = (moduleId: ModuleId, correct: boolean): void => {
    const before = marks;
    setMarks({ ...before, [moduleId]: correct });
    setError(null);
    void recordReview(moduleId, correct).then((response) => {
      if (response.ok) return;
      setMarks(before);
      setError(response.error.message);
    });
  };

  return (
    <section data-testid="review-queue">
      <p className="la-count" data-testid="review-header">{queueHeader(dueTotal, cards.length)}</p>
      <p className="la-muted">{REVIEW_INTRO}</p>
      {error === null ? null : (
        <p className="la-error" role="alert" data-testid="review-error">
          {error}
        </p>
      )}
      <ul className="la-list" data-testid="review-list">
        {cards.map((card) => {
          const mark = card.moduleId in marks ? marks[card.moduleId] : null;
          return (
            <li className="la-card" key={card.moduleId} data-testid="review-card">
              <h2><MathText text={card.title} /></h2>
              <p className="la-muted">
                {card.dueLabel}
                {card.needsAnotherLook ? ' · worth a second look' : ''}
              </p>
              <div className="la-row">
                <button
                  type="button"
                  data-testid={`review-remembered-${card.moduleId}`}
                  aria-pressed={mark === true}
                  onClick={(): void => record(card.moduleId, true)}
                >
                  {REMEMBERED_LABEL}
                </button>
                <button
                  type="button"
                  data-testid={`review-missed-${card.moduleId}`}
                  aria-pressed={mark === false}
                  onClick={(): void => record(card.moduleId, false)}
                >
                  {MISSED_LABEL}
                </button>
                <a className="la-btn-link" href={`/modules/${card.moduleId}/eval`}>{REVIEW_OPEN_LABEL}</a>
              </div>
              {mark === null ? null : (
                <p className="la-muted" data-testid={`review-outcome-${card.moduleId}`}>
                  {outcomeLine(mark)}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
