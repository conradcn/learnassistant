// FRACTAL: implements F1 | component C4
import type { TopicId } from '@/shapes';
import type { Store } from '@/store/open';
import { discardTopicDirectory } from '@/orchestrator/topic-state';

export type TopicCanceller = { cancelTopic(topicId: TopicId): string[] };

export type DeleteTopicDeps = {
  store: Store;
  dataRoot: string;
  orchestrator: TopicCanceller;
};

/**
 * Everything that has to happen when the learner deletes a subject, in the one order that
 * is safe.
 *
 * WHY it is a function and not three calls at the route: the order is the whole point. The
 * in-flight sessions are stopped FIRST, because a run that is still authoring keeps
 * writing after the rows are gone — a lesson row against a deleted topic fails on the
 * foreign key, and the failure path then wrote a status sidecar that put the subject's
 * directory back, unreachable forever after because only subjects with rows are ever
 * walked again. The rows go SECOND (jobs among them, so nothing queued can be claimed for
 * it), and the directory LAST, because until the rows are gone something may still
 * legitimately be reading it.
 */
export function deleteTopicEverywhere(deps: DeleteTopicDeps, topicId: TopicId): void {
  deps.orchestrator.cancelTopic(topicId);
  deps.store.topics.delete(topicId);
  discardTopicDirectory(deps.dataRoot, topicId);
}
