// FRACTAL: implements F2 | component C4
/**
 * The repair loop's ceiling, alone in a leaf file. WHY separated from repair.ts: these are
 * the numbers that bound how much work one planning run can do, and they are read by
 * callers that must not drag in repair.ts itself and everything it imports.
 */

/** Rounds of fix-then-recheck after the first consistency check. */
export const MAX_REPAIR_ROUNDS = 2;

/** The most lessons one round rewrites. */
export const REPAIR_TARGETS_PER_ROUND = 3;
