// FRACTAL: implements F3 | component C10
import type { LessonBlock } from '@/shapes';

export type CheckBlock = Extract<LessonBlock, { kind: 'check' }>;
export type StepsBlock = Extract<LessonBlock, { kind: 'steps' }>;

export type CheckFeedback = { correct: boolean; text: string };

/**
 * WHY there is no "score": a check is a commitment device, not a mark. The learner is asked
 * to pick before reading on, and whichever way they pick they are told what the picking was
 * about. Nothing is written down and nothing gates the rest of the lesson — F4 is where
 * being right or wrong has consequences.
 */
export function checkFeedback(block: CheckBlock, selected: number | null): CheckFeedback | null {
  if (selected === null) return null;
  const correct = selected === block.answerIndex;
  return { correct, text: correct ? block.whyRight : block.whyWrong };
}

/** The right answer's own text, shown alongside the correction once a wrong pick is made. */
export function correctOption(block: CheckBlock): string {
  return block.options[block.answerIndex];
}

/** Clamped so a stale index from a re-rendered block can never index off the end. */
export function stepAt(block: StepsBlock, index: number): { position: number; label: string; markdown: string } {
  const position = Math.min(Math.max(index, 0), block.steps.length - 1);
  const step = block.steps[position];
  return { position, label: step.label, markdown: step.markdown };
}

export function stepProgress(block: StepsBlock, index: number): string {
  return `Step ${stepAt(block, index).position + 1} of ${block.steps.length}`;
}

/**
 * A key that survives re-authoring: the ordinal alone collides across renders of different
 * content, and the content alone collides when a lesson legitimately repeats a block.
 */
export function blockKey(block: LessonBlock, index: number): string {
  return `${index}-${block.kind}`;
}

/**
 * How many blocks of prose sit in a row without anything to look at or do between them.
 * WHY this is measured at all: "more visuals" is only a real property of a lesson if it can
 * be checked, and the number that matters is not how many figures exist but how long the
 * learner goes without meeting one. Used by the tests that hold the authoring contract to
 * its word, and by the repair loop (C4), which queues a lesson that runs over it to be
 * rewritten. The renderer itself never refuses content over it, because a lesson that is
 * text-heavy is still a lesson and withholding it teaches nobody anything — the fix goes to
 * the writer, not to the reader.
 */
export function longestProseRun(blocks: readonly LessonBlock[]): number {
  let longest = 0;
  let run = 0;
  for (const block of blocks) {
    run = block.kind === 'prose' ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}
