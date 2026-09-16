// FRACTAL: implements F3, F5 | component C10
'use client';
import type { ReactNode } from 'react';
import { MathText } from '@/ui/components/MathText';

export type DegradedCardProps = {
  title: string;
  onRetryAuthoring: () => void;
  onDelete: () => void;
};

/**
 * WHY (H3): unreadable content is a state of its own. It never falls through to a blank
 * page, and both ways out of it are on the card itself.
 */
export function DegradedCard({ title, onRetryAuthoring, onDelete }: DegradedCardProps): ReactNode {
  return (
    <section className="la-card la-degraded" data-testid="degraded-card" role="alert">
      <h3>This lesson could not be read</h3>
      <p>
        The saved copy of “<MathText text={title} />” is damaged, so we can&apos;t show it. You
        can have it written again, or remove it and carry on with the rest.
      </p>
      <div className="la-row">
        <button type="button" onClick={onRetryAuthoring}>
          Write it again
        </button>
        <button type="button" onClick={onDelete}>
          Remove it
        </button>
      </div>
    </section>
  );
}
