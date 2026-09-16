// FRACTAL: implements F3, F5 | component C5
import type { ModuleState } from '@/shapes';

/**
 * What counts as having passed a lesson, alone in a leaf file with no imports but the
 * shapes. WHY separated from availability.ts: that module reaches the logger, and the
 * logger reaches `node:path`, so a client component that only needs to know whether a
 * lesson has been passed cannot import it without breaking the browser bundle. The fact
 * itself is one set; the graph reasoning that uses it stays where it is.
 */
const PASSED_STATES: ReadonlySet<ModuleState> = new Set<ModuleState>(['completed', 'assisted-pass']);

export function isPassedState(state: ModuleState): boolean {
  return PASSED_STATES.has(state);
}
