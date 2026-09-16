// FRACTAL: implements F4, F10 | component C10
'use client';
import type { ReactNode } from 'react';
import { MathText } from '@/ui/components/MathText';

export type PassCelebrationProps = {
  /** The lesson that was just cleared. */
  title: string;
  /** The outcome line the page already computed — kept verbatim so its testid stays here. */
  line: string;
};

const HEADLINE = 'That is yours now.';

/**
 * WHY: passing a lesson was the one moment in the whole app that looked exactly like
 * failing one — a single grey sentence under the transcript, in the same place, in the
 * same weight. The learner had just spent twenty minutes being questioned and the app
 * had nothing to say about it. This marks the moment: it is the only card that leads
 * with the accent, and it is shown once, on the turn that passed.
 *
 * WHY the card reads the same whether or not hints were needed: how much help a pass took
 * is a scheduling input (F7 books an assisted pass for earlier review), not something the
 * learner is told. Saying it here turns a finished lesson into a qualified one — a demerit
 * by another name — for a distinction they can do nothing with.
 *
 * WHY no score, badge, streak or count: the app deliberately has no marks anywhere
 * (see CalibrationCard), and a number here would quietly install one. The celebration
 * is the framing and the flourish, not a tally.
 */
export function PassCelebration({ title, line }: PassCelebrationProps): ReactNode {
  return (
    <section className="la-card la-celebrate" data-testid="pass-celebration">
      {/* Decorative only: the good news is carried by the heading, so this is hidden
          from assistive tech rather than read out as a stray character. */}
      <p className="la-celebrate-mark" aria-hidden="true">
        ✦
      </p>
      <h2 data-testid="pass-celebration-headline">{HEADLINE}</h2>
      <p data-testid="eval-outcome">{line}</p>
      <p className="la-muted" data-testid="pass-celebration-title">
        <MathText text={title} /> — worked through end to end, in your own words.
      </p>
    </section>
  );
}
