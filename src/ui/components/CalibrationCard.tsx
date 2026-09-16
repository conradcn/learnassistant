// FRACTAL: implements F10 | component C10
'use client';
import type { ReactNode } from 'react';
import type { CalibrationView } from '@/shapes';
import { CALIBRATION_NO_PREDICTION, CALIBRATION_TITLE } from '@/ui/journal-copy';

export type CalibrationCardProps = {
  view: CalibrationView;
};

/**
 * WHY (F10 AC): a plain side-by-side of what the learner expected and how it went. There
 * is no mark, no percentage and no letter anywhere in it, and the self-comparison is
 * simply absent when the learner never rated themselves.
 */
export function CalibrationCard({ view }: CalibrationCardProps): ReactNode {
  return (
    <section className="la-card" data-testid="calibration-card">
      <h2>{CALIBRATION_TITLE}</h2>
      <p data-testid="calibration-predicted">
        {view.predictedLabel === null ? CALIBRATION_NO_PREDICTION : `You expected: ${view.predictedLabel}`}
      </p>
      <p data-testid="calibration-actual">How it went: {view.actualLabel}</p>
      {view.selfVsEvaluator.length === 0 ? null : (
        <ul className="la-list" data-testid="calibration-self">
          {view.selfVsEvaluator.map((row) => (
            <li key={row.turnLabel} data-testid="calibration-row">
              On your {row.turnLabel} you said you were {row.selfLabel}; it {row.evaluatorLabel}.
            </li>
          ))}
        </ul>
      )}
      <p className="la-muted" data-testid="calibration-note">
        {view.note}
      </p>
    </section>
  );
}
