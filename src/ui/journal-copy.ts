// FRACTAL: implements F10, F11 | component C10
import type { Prediction, Reflection } from '@/shapes';

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
export const PREDICTION_SKIP_LABEL = 'Skip this';
export const PREDICTION_CHANGE_LABEL = 'Change my answer';
export const PREDICTION_SKIPPED_NOTE = 'Skipped. Carry straight on.';

export const CALIBRATION_TITLE = 'What you expected, and how it went';
/**
 * WHY: this line used to say "you skipped the up-front question", which read as an
 * accusation about the warm-up — the question learners actually answer before reading.
 * The thing that is missing is the confidence rating under the lesson title, a separate
 * control most learners never touch, so the line names that and blames nobody. It also
 * used to end "so there is nothing to compare", which the rest of the card contradicted:
 * the per-answer confidence ratings are collected separately and leave plenty to compare.
 */
export const CALIBRATION_NO_PREDICTION =
  'You did not rate your confidence under the lesson title before starting, so there is no before-and-after for the lesson as a whole.';

export const JOURNAL_INTRO =
  'Notes to yourself about what clicked and what did not. They are optional, and they come back to you word for word when a lesson comes round again.';
export const JOURNAL_EMPTY_MESSAGE = 'Nothing written about this subject yet.';
export const JOURNAL_NOTE_LABEL = 'Your note';
export const JOURNAL_PLACEHOLDER = 'What made sense? What is still murky?';
export const JOURNAL_SAVE = 'Save this note';
export const JOURNAL_EDIT_SAVE = 'Save changes';
export const JOURNAL_EDIT = 'Edit';
export const JOURNAL_SUBJECT_LABEL = 'Which subject is this about?';
export const JOURNAL_NO_SUBJECTS = 'Add a subject first and your notes can live alongside it.';

export function confidenceLabel(confidence: ConfidenceLevel): string {
  return CONFIDENCE_LABELS[confidence];
}

export function predictionSummary(prediction: Prediction): string {
  return prediction.skipped
    ? PREDICTION_SKIPPED_NOTE
    : `You said: ${confidenceLabel(prediction.confidence)}.`;
}

/** The stored text is passed through untouched — never trimmed, shortened or summarised. */
export function entryText(reflection: Reflection): string {
  return reflection.text;
}

export function entryStamp(reflection: Reflection): string {
  const edited = reflection.updatedAt !== reflection.createdAt;
  const when = new Date(reflection.updatedAt).toLocaleString();
  return edited ? `edited ${when}` : `written ${when}`;
}

export function newestFirst(entries: readonly Reflection[]): Reflection[] {
  return [...entries].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
