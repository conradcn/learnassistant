// FRACTAL: implements F14 | component C10
'use client';
import { useState, type ReactNode } from 'react';
import type { CardGrade, CardView } from '@/shapes';
import { gradeCard } from '@/ui/api-client';
import { MathText } from '@/ui/components/MathText';
import { dueLine, GRADE_LABELS, gradedLine, REVEAL_LABEL, studyHeader, STUDY_EMPTY_MESSAGE } from '@/ui/cards-copy';

export type CardStudyProps = {
  cards: readonly CardView[];
  onDone?: () => void;
};

/**
 * WHY the back is withheld until the learner asks for it: the whole value of a card is the
 * moment of trying to retrieve before seeing. Rendering both sides at once turns retrieval
 * practice into reading, which is the one thing the evidence says does not work. Same rule
 * as F3's try-before-you-look reveal.
 */
export function CardStudy({ cards, onDone }: CardStudyProps): ReactNode {
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (cards.length === 0) {
    return (
      <p className="la-empty" data-testid="study-empty">
        {STUDY_EMPTY_MESSAGE}
      </p>
    );
  }

  if (index >= cards.length) {
    return (
      <section data-testid="study-finished">
        <p className="la-count">{studyHeader(0, cards.length)}</p>
        <p className="la-muted">That is everything due. Nothing else is waiting on you.</p>
        {onDone === undefined ? null : (
          <button type="button" data-testid="study-again" onClick={onDone}>
            Look again
          </button>
        )}
      </section>
    );
  }

  const card = cards[index];

  const answer = (grade: CardGrade): void => {
    setNote(gradedLine(grade));
    setError(null);
    // WHY optimistic: the next card lands on the click, and a failed write puts the note
    // back rather than the card — the learner is never left waiting on the network to see
    // the thing they already remembered.
    void gradeCard(card.id, grade).then((response) => {
      if (!response.ok) setError(response.error.message);
    });
    setIndex((current) => current + 1);
    setRevealed(false);
  };

  return (
    <section data-testid="card-study">
      <p className="la-count" data-testid="study-header">
        {studyHeader(cards.length - index, cards.length)}
      </p>
      {error === null ? null : (
        <p className="la-error" role="alert" data-testid="study-error">
          {error}
        </p>
      )}
      <div className="la-card" data-testid="study-card">
        <MathText as="div" text={card.front} className="la-card-front" testId="card-front" />
        <p className="la-muted">{dueLine(card)}</p>
        {revealed ? (
          <>
            <MathText as="div" text={card.back} className="la-card-back" testId="card-back" />
            <div className="la-row">
              {GRADE_LABELS.map(({ grade, label }) => (
                <button
                  key={grade}
                  type="button"
                  data-testid={`card-grade-${grade}`}
                  onClick={(): void => answer(grade)}
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        ) : (
          <button
            type="button"
            className="la-primary"
            data-testid="card-reveal"
            onClick={(): void => setRevealed(true)}
          >
            {REVEAL_LABEL}
          </button>
        )}
      </div>
      {note === null ? null : (
        <p className="la-muted" data-testid="study-note">
          {note}
        </p>
      )}
    </section>
  );
}
