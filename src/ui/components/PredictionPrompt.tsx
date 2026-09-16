// FRACTAL: implements F10 | component C10
'use client';
import { useState, type ReactNode } from 'react';
import { isoDateStringSchema, type ModuleId, type Prediction } from '@/shapes';
import { recordPrediction } from '@/ui/api-client';
import {
  confidenceLabel,
  CONFIDENCE_LEVELS,
  PREDICTION_QUESTION,
  PREDICTION_CHANGE_LABEL,
  PREDICTION_SKIP_LABEL,
  predictionSummary,
  type ConfidenceLevel,
} from '@/ui/journal-copy';

export type PredictionPromptProps = {
  moduleId: ModuleId;
  existing?: Prediction | null;
  onRecorded?: (prediction: Prediction) => void;
};

export function buildPrediction(
  moduleId: ModuleId,
  confidence: ConfidenceLevel,
  skipped: boolean,
  at: string = new Date().toISOString(),
): Prediction {
  return { moduleId, confidence, expectation: '', skipped, at: isoDateStringSchema.parse(at) };
}

/**
 * WHY (F10 AC): one light question that never blocks the lesson. The answer lands on the
 * same tick, the buttons stay live, and skipping is a first-class answer.
 */
export function PredictionPrompt({ moduleId, existing, onRecorded }: PredictionPromptProps): ReactNode {
  const [recorded, setRecorded] = useState<Prediction | null>(existing ?? null);
  // WHY: an answer given before the lesson is the only honest one. Coming back after
  // reading and being asked again would quietly replace that first guess with hindsight,
  // so the earlier answer is shown back and changing it has to be asked for.
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = (confidence: ConfidenceLevel, skipped: boolean): void => {
    const before = recorded;
    const optimistic = buildPrediction(moduleId, confidence, skipped);
    setRecorded(optimistic);
    setChanging(false);
    setError(null);
    void recordPrediction(optimistic).then((response) => {
      if (response.ok) {
        setRecorded(response.data);
        onRecorded?.(response.data);
        return;
      }
      setRecorded(before);
      setError(response.error.message);
    });
  };

  return (
    <section className="la-card" data-testid="prediction-prompt">
      <p>{PREDICTION_QUESTION}</p>
      {recorded !== null && !changing ? (
        <p className="la-row">
          <button
            type="button"
            data-testid="prediction-change"
            style={{ background: 'transparent', borderColor: 'transparent', color: 'var(--muted)' }}
            onClick={(): void => setChanging(true)}
          >
            {PREDICTION_CHANGE_LABEL}
          </button>
        </p>
      ) : (
        <>
          <div className="la-row">
            {CONFIDENCE_LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                data-testid={`prediction-level-${level}`}
                onClick={(): void => send(level, false)}
              >
                {confidenceLabel(level)}
              </button>
            ))}
          </div>
          {/* WHY: skipping is not a sixth confidence level, so it sits on its own line and
              reads as a quiet way out rather than an answer. */}
          <p>
            <button
              type="button"
              data-testid="prediction-skip"
              style={{ background: 'transparent', borderColor: 'transparent', color: 'var(--muted)' }}
              onClick={(): void => send(3, true)}
            >
              {PREDICTION_SKIP_LABEL}
            </button>
          </p>
        </>
      )}
      {error === null ? null : (
        <p className="la-error" role="alert" data-testid="prediction-error">
          {error}
        </p>
      )}
      {recorded === null ? null : (
        <p className="la-muted" data-testid="prediction-recorded">
          {predictionSummary(recorded)}
        </p>
      )}
    </section>
  );
}
