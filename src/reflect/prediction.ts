// FRACTAL: implements F10 | component C8
import { isoDateStringSchema, predictionSchema, type ISODateString, type ModuleId, type Prediction } from '@/shapes';
import type { Store } from '@/store/open';
import { err } from '@/core/errors';
import { log } from '@/core/log';

export type ConfidenceLevel = Prediction['confidence'];

export const CONFIDENCE_LEVELS: readonly ConfidenceLevel[] = [1, 2, 3, 4, 5];

const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = {
  1: 'completely new to me',
  2: 'shaky on this',
  3: 'somewhat confident',
  4: 'fairly confident',
  5: 'very confident',
};

export const PREDICTION_QUESTION = 'Before you start — how well do you think you already know this?';
export const PREDICTION_SKIP_LABEL = 'Skip';

export type PredictionOption = { value: ConfidenceLevel; label: string };

export type PredictionPrompt = {
  moduleId: ModuleId;
  question: string;
  options: PredictionOption[];
  skipLabel: string;
  blocking: false;
  existing: Prediction | null;
};

export function confidenceLabel(confidence: ConfidenceLevel): string {
  return CONFIDENCE_LABELS[confidence];
}

export function nowIso(): ISODateString {
  return isoDateStringSchema.parse(new Date().toISOString());
}

export function predictionPrompt(store: Store, moduleId: ModuleId): PredictionPrompt {
  return {
    moduleId,
    question: PREDICTION_QUESTION,
    options: CONFIDENCE_LEVELS.map((value) => ({ value, label: CONFIDENCE_LABELS[value] })),
    skipLabel: PREDICTION_SKIP_LABEL,
    blocking: false,
    existing: predictionFor(store, moduleId),
  };
}

export function predictionFor(store: Store, moduleId: ModuleId): Prediction | null {
  try {
    return store.predictions.get(moduleId);
  } catch (e) {
    log({
      level: 'warn',
      event: 'prediction-read-failed',
      component: 'C8',
      moduleId,
      detail: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

export function recordPrediction(store: Store, p: Prediction): Prediction {
  const parsed = predictionSchema.safeParse(p);
  if (!parsed.success) {
    throw err('validation', { detail: 'prediction failed shape validation' });
  }
  const prediction = parsed.data;
  try {
    store.predictions.upsert(prediction);
    log({
      level: 'info',
      event: 'prediction-recorded',
      component: 'C8',
      moduleId: prediction.moduleId,
      skipped: prediction.skipped,
    });
  } catch (e) {
    log({
      level: 'warn',
      event: 'prediction-save-degraded',
      component: 'C8',
      moduleId: prediction.moduleId,
      skipped: prediction.skipped,
      detail: e instanceof Error ? e.message : String(e),
    });
  }
  return prediction;
}

export function skipPrediction(store: Store, moduleId: ModuleId): Prediction {
  return recordPrediction(store, {
    moduleId,
    confidence: 3,
    expectation: '',
    skipped: true,
    at: nowIso(),
  });
}
