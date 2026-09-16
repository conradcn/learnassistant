// FRACTAL: implements F1 | component C9
import type { DashboardView, ISODateString, ModuleGraph, TopicId } from '@/shapes';
import { evalTargetSchema } from '@/shapes';
import type { Store } from '@/store/open';
import { dashboard, type DashboardSource, type TopicAggregate } from '@/graph/dashboard';
import { completedSet, isPassedState } from '@/graph/availability';
import { progressCounts } from '@/graph/rollup';
import { capstoneNode, capstoneRounds, capstoneStatus } from '@/eval/capstone';
import { sessionIdFor } from '@/eval/session';
import { readTopicState } from '@/orchestrator/topic-state';

/**
 * WHY (H10): this used to derive the status from the capstone node's state alone, so an
 * available capstone read as "being looked over" on the dashboard while the project page —
 * which asks the canonical rule in @/eval/capstone — showed it as never started. Two screens,
 * two answers, one project. There is one rule and this asks it.
 */
function capstoneStatusOf(store: Store, topicId: TopicId, graph: ModuleGraph): string {
  const node = capstoneNode(graph);
  if (node === null) return 'n/a';
  // A passed capstone is passed whatever the transcript says, so don't materialise
  // every round's turns to be told so.
  if (isPassedState(node.state)) return capstoneStatus(node, []);
  const session = store.evals.get(
    sessionIdFor('capstone', evalTargetSchema.parse({ kind: 'capstone', topicId })),
  );
  return capstoneStatus(node, session === null ? [] : capstoneRounds(session));
}

/** WHY: C5's SQL source needs the raw database handle, which C1 does not hand out; this
 *  reads the same numbers through the repositories the API already holds. */
export function storeDashboardSource(store: Store, dataRoot?: string): DashboardSource {
  /**
   * WHY one pass: `topicAggregates` and `topicsWithCompletedModulesCount` used to walk every
   * topic's graph independently, so a single dashboard render read — and JSON.parse'd — every
   * lesson blob in the database twice. Both answers now come out of one traversal, computed on
   * first ask and reused for the second. Each source is built per request, so nothing is cached
   * across renders.
   */
  let pass: { aggregates: TopicAggregate[]; topicsWithCompleted: number } | null = null;

  function walk(): { aggregates: TopicAggregate[]; topicsWithCompleted: number } {
    if (pass !== null) return pass;
    const aggregates: TopicAggregate[] = [];
    let topicsWithCompleted = 0;
    for (const topic of store.topics.list()) {
      if ('degraded' in topic) continue;
      // Blob-free: the dashboard reads ids, kinds and states only, never `content`.
      const graph = store.modules.summaryGraph(topic.id);
      const counts = progressCounts(graph, completedSet(graph));
      if (graph.nodes.some((node) => isPassedState(node.state))) topicsWithCompleted += 1;
      aggregates.push({
        id: topic.id,
        subject: topic.subject,
        // Same reason as `hydrateTopic`: the row's status is frozen at `queued`, so the
        // home page card has to read progress from the state file too.
        storedStatus: dataRoot === undefined ? topic.status : readTopicState(dataRoot, topic.id).status,
        capstoneStatus: capstoneStatusOf(store, topic.id, graph),
        moduleCount: counts.completedCount + counts.availableCount + counts.remainingCount,
        completedCount: counts.completedCount,
        availableCount: counts.availableCount,
        needsReviewCount: counts.needsReviewCount,
        assistedPassCount: counts.assistedPassCount,
      });
    }
    pass = { aggregates, topicsWithCompleted };
    return pass;
  }

  return {
    topicAggregates(): TopicAggregate[] {
      return walk().aggregates;
    },
    reviewsDueCount(now: ISODateString): number {
      return store.reviews.due(now, 5000).length;
    },
    topicsWithCompletedModulesCount(): number {
      return walk().topicsWithCompleted;
    },
  };
}

export function dashboardFor(store: Store, dataRoot?: string): DashboardView {
  return dashboard(storeDashboardSource(store, dataRoot));
}
