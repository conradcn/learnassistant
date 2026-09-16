// FRACTAL: implements F5, F13 | component C5
import { z } from 'zod';
import {
  type CapstoneRollupStatus,
  type ModuleGraph,
  type ModuleId,
  type TopicStatus,
} from '@/shapes';
import { availability, isPassedState } from '@/graph/availability';

export const progressCountsSchema = z.object({
  completedCount: z.number(),
  availableCount: z.number(),
  remainingCount: z.number(),
  needsReviewCount: z.number(),
  assistedPassCount: z.number(),
});
export type ProgressCounts = z.infer<typeof progressCountsSchema>;

export function progressCounts(g: ModuleGraph, completed: Set<ModuleId>): ProgressCounts {
  // WHY the map: this used to scan `g.nodes` once per availability row, which the dashboard
  // pays for on every module of every topic. Same filter, one pass.
  const kindOf = new Map<ModuleId, string>();
  for (const node of g.nodes) kindOf.set(node.id, node.kind);
  const rows = availability(g, completed).filter((row) => {
    const kind = kindOf.get(row.moduleId);
    return kind !== undefined && kind !== 'capstone';
  });
  let completedCount = 0;
  let availableCount = 0;
  let needsReviewCount = 0;
  let assistedPassCount = 0;
  for (const row of rows) {
    if (isPassedState(row.state)) {
      completedCount += 1;
      if (row.state === 'assisted-pass') assistedPassCount += 1;
      continue;
    }
    if (row.state === 'available') availableCount += 1;
    if (row.state === 'needs-review') needsReviewCount += 1;
  }
  return {
    completedCount,
    availableCount,
    remainingCount: Math.max(0, rows.length - completedCount - availableCount),
    needsReviewCount,
    assistedPassCount,
  };
}

export function topicRollup(
  g: ModuleGraph,
  completed: Set<ModuleId>,
  capstoneStatus: CapstoneRollupStatus,
): TopicStatus {
  const moduleNodes = g.nodes.filter((n) => n.kind !== 'capstone');
  if (moduleNodes.length === 0) return 'queued';
  const allPassed = moduleNodes.every((n) => completed.has(n.id));
  if (!allPassed) return 'ready';
  return capstoneStatus === 'passed' ? 'done' : 'modules-complete';
}

export function rollupFromCounts(
  moduleCount: number,
  completedCount: number,
  capstoneStatus: CapstoneRollupStatus,
  storedStatus: TopicStatus,
): TopicStatus {
  if (moduleCount === 0) return storedStatus;
  if (completedCount < moduleCount) {
    return storedStatus === 'modules-complete' || storedStatus === 'done' ? 'ready' : storedStatus;
  }
  return capstoneStatus === 'passed' ? 'done' : 'modules-complete';
}
