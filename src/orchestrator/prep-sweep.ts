// FRACTAL: implements F2 | component C4
import type { Store } from '@/store/open';
import { log } from '@/core/log';
import { prepareAvailable, unpreparedAvailable, type PrepRequester } from '@/orchestrator/prepare-available';
import { readTopicState, recordPrepAttempt } from '@/orchestrator/topic-state';

export type PrepSweepDeps = {
  store: Store;
  dataRoot: string;
  orchestrator: PrepRequester;
};

export type PrepSweepResult = {
  /** Topics that had unwritten lessons whose prerequisites the learner has already met. */
  considered: number;
  /** Topics for which this sweep queued a writing pass. */
  queued: number;
  /** Of those, the ones that were queued to recover a subject in `needs-attention`. */
  recovered: number;
};

/** How often the sweep runs. Long enough that an idle app is idle; short enough that a
 *  learner who leaves a subject waiting finds it written when they come back. */
export const PREP_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * WHY this exists on top of C6's per-pass call: `prepareAvailable` only ever runs on the
 * turn that passes a lesson, so a subject whose available-but-unwritten lessons appeared
 * any other way had nobody coming for them — a pass that was interrupted mid-window, a
 * window that deferred lessons the learner has since unlocked, a topic that went
 * `needs-attention` and was later retried into `ready`, or a process that restarted
 * between the pass and the queueing. Those subjects sat with an empty lesson behind an
 * "available" badge until the learner pressed the button themselves. This sweeps every
 * topic and queues the same pass the button queues.
 *
 * Every gate is `prepareAvailable`'s own — including the bounded retry of subjects left in
 * `needs-attention`, which is what stops one bad session from parking a whole course — and
 * a refusal is logged rather than raised. The extra `pendingFor` check is
 * cheap insurance against handing a second pass to a subject that already has a job in the
 * queue, since the sidecar status and the job table are written separately.
 */
export function sweepUnpreparedAvailable(deps: PrepSweepDeps): PrepSweepResult {
  let considered = 0;
  let queued = 0;
  let recovered = 0;
  for (const topic of deps.store.topics.list()) {
    if ('degraded' in topic) continue;
    const graph = deps.store.modules.graph(topic.id);
    if (unpreparedAvailable(graph).length === 0) continue;
    considered += 1;
    if (deps.store.jobs.pendingFor(topic.id) > 0) continue;
    const outcome = prepareAvailable(deps.orchestrator, topic, graph, readTopicState(deps.dataRoot, topic.id));
    if (!outcome.queued) continue;
    queued += 1;
    if (!outcome.recovery) continue;
    recovered += 1;
    // WHY only the recovery passes are counted against the budget: a healthy subject
    // being written a window at a time is making progress on every pass, and charging it
    // would end with the sweep abandoning a course that is going perfectly well.
    recordPrepAttempt(deps.dataRoot, topic.id);
  }
  if (considered > 0) {
    log({ level: 'info', event: 'prep-sweep-ran', component: 'C4', considered, queued, recovered });
  }
  return { considered, queued, recovered };
}
