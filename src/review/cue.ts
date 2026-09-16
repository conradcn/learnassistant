// FRACTAL: implements F7 | component C7
import type { ReviewCue, ReviewItem } from '@/shapes';

/**
 * Narrow a `ReviewItem` to what may leave the process.
 *
 * WHY this exists as its own function rather than an inline object literal at each route:
 * it is the single place the memory model is dropped, so `tests/review/no-scores.test.ts`
 * has one thing to assert about and a future field added to `ReviewItem` cannot reach the
 * browser by being spread into a response.
 */
export function toCue(item: ReviewItem): ReviewCue {
  return {
    moduleId: item.moduleId,
    dueAt: item.dueAt,
    needsAnotherLook: item.flaggedNeedsReview,
  };
}
