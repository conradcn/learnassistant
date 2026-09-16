// FRACTAL: implements F2 | component C4
import type { Job, ModuleGraph, ModuleNode, Topic, TopicStatus } from '@/shapes';
import { AppError } from '@/core/errors';
import { log } from '@/core/log';
import { availability, completedSet } from '@/graph/availability';

export type PrepRequester = {
  resumeGeneration(topicId: Topic['id']): Job;
};

export type PrepareOutcome =
  | { queued: true; jobId: string; modules: ModuleNode[]; recovery: boolean }
  | { queued: false; reason: 'nothing-to-prepare' | 'busy' | 'refused' | 'attempts-exhausted' };

/** What the decision needs from C4's sidecar. The whole state satisfies it. */
export type PrepState = { status: TopicStatus; prepAttempts: number };

/**
 * The lessons the learner has earned the right to start and that nobody has written yet.
 * "Prerequisites met" is the derived availability in C5, not the stored state, so a node
 * whose prerequisites were passed in the same transaction counts immediately.
 */
export function unpreparedAvailable(graph: ModuleGraph): ModuleNode[] {
  const derived = new Map(availability(graph, completedSet(graph)).map((a) => [a.moduleId, a.state]));
  return graph.nodes
    .filter((n) => n.kind !== 'capstone' && n.content === null && derived.get(n.id) === 'available')
    .sort((a, b) => a.ordinal - b.ordinal);
}

// WHY: a pass unlocks the next lessons, and until now the ones that were unlocked but
// unwritten simply sat there — the learner finished a lesson, was told what it opened up,
// clicked into it and found nothing, and had to go back to the subject page and press
// "Write the lessons" themselves. Preparing them in the background at the moment they are
// unlocked is the whole point of a lookahead window; the learner meets a written lesson.
const PREPARABLE: ReadonlySet<TopicStatus> = new Set<TopicStatus>(['ready', 'ready-with-notes']);

/**
 * WHY `needs-attention` is now preparable too, under a budget: it is not a diagnosis, it
 * is the mark left by ONE pass that did not go perfectly — a single lesson whose session
 * came back malformed, or research that landed an outline and handed the writing back. The
 * subject then sat there permanently ineligible: the sweep saw its available-but-unwritten
 * lessons every five minutes, refused it as "busy", and the learner's next lesson was never
 * written by anything but the button. On real subjects this is most of them — one bad
 * session out of ten parked twenty-four lessons indefinitely.
 *
 * The pass this queues is itself the error-fixing loop: `runAuthoringPhase` retires the
 * failure notes for the lessons it is about to rewrite, rewrites them, and re-runs the
 * consistency check, so a retry that succeeds clears the very state that made the subject
 * `needs-attention`. What is bounded is a retry that never succeeds.
 */
const RECOVERABLE: ReadonlySet<TopicStatus> = new Set<TopicStatus>(['needs-attention']);

/**
 * How many consecutive background passes a subject in trouble is given before the loop
 * gives up and leaves it to the learner. Reset by any pass that writes a lesson, so this
 * bounds fruitless retries, not the number of passes a long course takes.
 */
export const MAX_RECOVERY_ATTEMPTS = 3;

/**
 * WHY the pass is queued without asking: it is exactly the pass the button on the subject
 * page queues, and the learner already asked for it by passing the lesson that unlocked
 * these ones.
 *
 * `status` is C4's own sidecar status, not the topic row's — the row is written once at
 * intake and says `queued` forever, so reading it here would decide "a pass is already
 * running" from a value that never moves.
 */
export function prepareAvailable(
  orchestrator: PrepRequester,
  topic: Topic,
  graph: ModuleGraph,
  state: PrepState,
): PrepareOutcome {
  const modules = unpreparedAvailable(graph);
  if (modules.length === 0) return { queued: false, reason: 'nothing-to-prepare' };
  const { status } = state;
  const recovery = !PREPARABLE.has(status) && RECOVERABLE.has(status);
  // A pass already in flight is writing these very lessons.
  if (!PREPARABLE.has(status) && !recovery) {
    log({ level: 'info', event: 'prep-available-skipped', component: 'C4', topicId: topic.id, status });
    return { queued: false, reason: 'busy' };
  }
  if (recovery && state.prepAttempts >= MAX_RECOVERY_ATTEMPTS) {
    log({
      level: 'info',
      event: 'prep-available-exhausted',
      component: 'C4',
      topicId: topic.id,
      prepAttempts: state.prepAttempts,
    });
    return { queued: false, reason: 'attempts-exhausted' };
  }
  try {
    const job = orchestrator.resumeGeneration(topic.id);
    log({
      level: 'info',
      event: 'prep-available-queued',
      component: 'C4',
      topicId: topic.id,
      jobId: job.id,
      unpreparedAvailable: modules.length,
      recovery,
      prepAttempts: state.prepAttempts,
    });
    return { queued: true, jobId: job.id, modules, recovery };
  } catch (e) {
    // WHY swallowed: this is work the learner did not ask for by name, so a subject that
    // cannot take it right now must not fail the turn they did ask for.
    if (e instanceof AppError) {
      log({ level: 'info', event: 'prep-available-refused', component: 'C4', topicId: topic.id, code: e.code });
      return { queued: false, reason: 'refused' };
    }
    throw e;
  }
}
