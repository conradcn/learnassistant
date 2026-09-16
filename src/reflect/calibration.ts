// FRACTAL: implements F10 | component C8
import {
  calibrationSchema,
  type AssistLevel,
  type Calibration,
  type CalibrationView,
  type EvalSession,
  type ModuleId,
} from '@/shapes';
import type { Store } from '@/store/open';
import { log } from '@/core/log';
import type { ConfidenceLevel } from '@/reflect/prediction';
import { confidenceLabel } from '@/reflect/prediction';

const ASSIST_LABELS: Record<AssistLevel, string> = {
  0: 'got there unaided',
  1: 'needed a nudge',
  2: 'needed a couple of hints',
  3: 'needed it walked through',
};

const ORDINALS = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
];

export const ALIGNED_NOTE = 'Your sense of it lined up with how the lesson went.';
export const DIVERGED_NOTE = 'Worth noticing where the two differed.';
export const PLAIN_NOTE = 'Here is how the lesson went.';

export type { CalibrationView } from '@/shapes';

export function assistLabel(level: AssistLevel): string {
  return ASSIST_LABELS[level];
}

function turnLabel(index: number): string {
  const word = ORDINALS[index];
  return word ? `${word} answer` : 'a later answer';
}

function expectedAssist(confidence: ConfidenceLevel): AssistLevel {
  const raw = 5 - confidence;
  return (raw > 3 ? 3 : raw) as AssistLevel;
}

function aligned(confidence: ConfidenceLevel, assist: AssistLevel): boolean {
  return Math.abs(expectedAssist(confidence) - assist) <= 1;
}

export function selfAssessmentPairs(session: EvalSession | null): Calibration['selfVsEvaluator'] {
  if (!session) return [];
  const pairs: Calibration['selfVsEvaluator'] = [];
  for (let i = 0; i < session.turns.length; i += 1) {
    const turn = session.turns[i];
    if (!turn.selfAssessment) continue;
    let evaluatorAssist: AssistLevel = turn.assistLevel ?? 0;
    if (turn.assistLevel === null) {
      for (let j = i + 1; j < session.turns.length; j += 1) {
        const later = session.turns[j];
        if (later.role === 'evaluator' && later.assistLevel !== null) {
          evaluatorAssist = later.assistLevel;
          break;
        }
      }
    }
    pairs.push({ turnId: turn.id, self: turn.selfAssessment.confidence, evaluatorAssist });
  }
  return pairs;
}

export function highestAssistLevel(session: EvalSession | null): AssistLevel {
  if (!session) return 0;
  let highest: AssistLevel = 0;
  for (const turn of session.turns) {
    if (turn.assistLevel !== null && turn.assistLevel > highest) highest = turn.assistLevel;
  }
  return highest;
}

export function computeCalibration(
  store: Store,
  moduleId: ModuleId,
  session: EvalSession | null,
): Calibration | null {
  const prediction = store.predictions.get(moduleId);
  const usablePrediction = prediction && !prediction.skipped ? prediction : null;
  const pairs = selfAssessmentPairs(session);
  if (!usablePrediction && pairs.length === 0) return null;

  const calibration: Calibration = {
    moduleId,
    predicted: usablePrediction ? usablePrediction.confidence : null,
    actualAssistLevel: highestAssistLevel(session),
    selfVsEvaluator: pairs,
  };
  const parsed = calibrationSchema.parse(calibration);
  store.calibration.upsert(parsed);
  log({
    level: 'info',
    event: 'calibration-computed',
    component: 'C8',
    moduleId,
    hasPrediction: usablePrediction !== null,
    selfAssessmentCount: pairs.length,
  });
  return parsed;
}

function noteFor(calibration: Calibration): string {
  const rowsDiverge = calibration.selfVsEvaluator.some(
    (r) => !aligned(r.self, r.evaluatorAssist),
  );
  if (rowsDiverge) return DIVERGED_NOTE;
  if (calibration.predicted === null) return PLAIN_NOTE;
  return aligned(calibration.predicted, calibration.actualAssistLevel) ? ALIGNED_NOTE : DIVERGED_NOTE;
}

export function toCalibrationView(calibration: Calibration): CalibrationView {
  return {
    moduleId: calibration.moduleId,
    predictedLabel: calibration.predicted === null ? null : confidenceLabel(calibration.predicted),
    actualLabel: assistLabel(calibration.actualAssistLevel),
    selfVsEvaluator: calibration.selfVsEvaluator.map((row, index) => ({
      turnLabel: turnLabel(index),
      selfLabel: confidenceLabel(row.self),
      evaluatorLabel: assistLabel(row.evaluatorAssist),
    })),
    note: noteFor(calibration),
  };
}

export function calibrationFor(store: Store, moduleId: ModuleId): CalibrationView | null {
  const stored = store.calibration.get(moduleId);
  if (!stored) return null;
  if (stored.predicted === null && stored.selfVsEvaluator.length === 0) return null;
  return toCalibrationView(stored);
}
