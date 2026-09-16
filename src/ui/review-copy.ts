// FRACTAL: implements F7 | component C10
import type { ModuleId, ReviewCue } from '@/shapes';

export type ReviewCardView = {
  moduleId: ModuleId;
  title: string;
  dueLabel: string;
  needsAnotherLook: boolean;
};

export const REVIEW_INTRO =
  'These are lessons worth revisiting today. Take any of them, in any order, or none at all — nothing here holds up the rest of your learning.';
export const REVIEW_EMPTY_MESSAGE = 'Nothing to revisit today. Finished lessons come back here on their own.';
export const REVIEW_UNTITLED = 'A lesson you finished earlier';
export const REMEMBERED_LABEL = 'I remembered this';
export const MISSED_LABEL = 'I had forgotten this';
export const REVIEW_OPEN_LABEL = 'Talk this one through';

export function queueHeader(dueTotal: number, shown: number): string {
  if (dueTotal > shown) return `${dueTotal} due, showing today's ${shown}`;
  return shown === 1 ? '1 due today' : `${shown} due today`;
}

export function dueLabel(item: ReviewCue, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - Date.parse(item.dueAt)) / 86_400_000);
  if (days <= 0) return 'ready now';
  // "waiting since N days ago" doubles the preposition; the plain form is the one a
  // learner would say out loud.
  if (days === 1) return 'waiting since yesterday';
  return `waiting for ${days} days`;
}

export function toCard(item: ReviewCue, title: string | null, now: Date = new Date()): ReviewCardView {
  return {
    moduleId: item.moduleId,
    title: title === null || title.length === 0 ? REVIEW_UNTITLED : title,
    dueLabel: dueLabel(item, now),
    needsAnotherLook: item.needsAnotherLook,
  };
}

export function outcomeLine(correct: boolean): string {
  return correct
    ? 'Noted — this one will come back later on.'
    : 'Noted — this one will come back sooner.';
}
