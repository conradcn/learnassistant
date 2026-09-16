// FRACTAL: implements F1 | component C9
import type { Job, ModuleAvailability, ModuleGraph, ModuleId, ModuleNode, TopicExtension, TopicId } from '@/shapes';
import type { DegradedTopic } from '@/store/topics';
import type { Topic, CardDeck, EntryDecision, CalibrationView, LessonQuestion, Prediction, WarmUpRecord } from '@/shapes';
import { calibrationFor } from '@/reflect/calibration';
import { predictionFor } from '@/reflect/prediction';
import { warmUpFor } from '@/reflect/warm-up-history';
import { lessonQuestionsFor } from '@/reflect/lesson-questions';
import { err } from '@/core/errors';
import { availability, completedSet } from '@/graph/availability';
import { canEnter } from '@/graph/entry';
import { locate } from '@/review/locate';
import { findPackDeck } from '@/cards/library';
import { topicDir, moduleDir } from '@/api/confine';
import { readTopicState, resetPrepAttempts } from '@/orchestrator/topic-state';
import { NEVER_WRITTEN_REASON, readContentFile } from '@/orchestrator/reconcile';
import type { Services } from '@/api/services';

export type TopicDetail = {
  topic: Topic | DegradedTopic;
  graph: ModuleGraph;
  availability: ModuleAvailability[];
  extensions: TopicExtension[];
};

/**
 * WHY (F10): the lesson's own prediction and its calibration comparison travel with the
 * lesson, so the page that asks the question and the page that shows how it went both
 * read one response instead of guessing.
 */
/**
 * Why a lesson has no content to show. `never-written` is the ordinary state of a planned
 * lesson whose writing session has not run yet; `damaged` is the rare one where a file
 * exists and will not load. They were the same value (`content: null`) until now, so the
 * common case wore the rare case's words and every unwritten lesson told the learner their
 * saved copy was damaged.
 */
export type ContentIssue = 'never-written' | 'damaged';

export type ModuleDetail = {
  module: ModuleNode;
  entry: EntryDecision;
  prediction: Prediction | null;
  /** The learner's earlier go at the warm-up, so a revisit does not ask for a new one. */
  warmUp: WarmUpRecord | null;
  /** What they have already asked about this lesson, oldest first, with the answers. */
  questions: LessonQuestion[];
  calibration: CalibrationView | null;
  /** null when the lesson has content. */
  contentIssue: ContentIssue | null;
  /**
   * The deck this lesson's card pack has already been added to, or null. WHY it is served
   * with the lesson rather than remembered in the browser: "I already took these" has to
   * survive a reload, and the deck itself is the only honest record of it.
   */
  cardPackDeck: CardDeck | null;
};

/**
 * WHY: the `topics` row is written once, at create, and never again — `TopicsRepo` has
 * no update at all. Everything that moves after that (status, the driving question, the
 * notes) is written by C4 to the topic's own state file. Serving the row therefore told
 * every learner their subject was still `queued`, so the subject page showed "We are
 * planning your lessons" forever: the outline had landed, the status said otherwise, and
 * the page hid the plan and the button that authorises writing it behind that status.
 * The row still owns identity and intake; the state file owns progress.
 */
export function hydrateTopic(dataRoot: string, topic: Topic | DegradedTopic): Topic | DegradedTopic {
  if ('degraded' in topic) return topic;
  const state = readTopicState(dataRoot, topic.id);
  return {
    ...topic,
    status: state.status,
    drivingQuestion: state.drivingQuestion ?? topic.drivingQuestion,
    notes: state.notes,
  };
}

export function topicDetail(svc: Services, topicId: TopicId): TopicDetail {
  topicDir(svc.dataRoot, topicId);
  const stored = svc.store.topics.get(topicId);
  if (stored === null) {
    throw err('not-found', { detail: 'topic detail requested for an unknown id', userMessage: 'We could not find that subject.' });
  }
  const topic = hydrateTopic(svc.dataRoot, stored);
  const graph = svc.store.modules.graph(topicId);
  return {
    topic,
    graph,
    availability: availability(graph, completedSet(graph)),
    extensions: readTopicState(svc.dataRoot, topicId).extensions,
  };
}

// WHY the disk check: the row losing its content and the file never being written are the
// same NULL in the store. Only the file tells them apart — absent means the writing session
// has not run, present-but-unloadable means the saved copy really is broken.
function contentIssueFor(dataRoot: string, topicId: TopicId, moduleId: ModuleId): ContentIssue {
  const load = readContentFile(dataRoot, topicId, moduleId);
  if (load.ok) return 'damaged';
  return load.degradedReason === NEVER_WRITTEN_REASON ? 'never-written' : 'damaged';
}

export function moduleDetail(svc: Services, moduleId: ModuleId): ModuleDetail {
  const located = locate(svc.store, moduleId);
  if (located === null) {
    throw err('not-found', { detail: 'module detail requested for an unknown id', userMessage: 'We could not find that lesson.' });
  }
  moduleDir(svc.dataRoot, located.topic.id, moduleId);
  const graph = svc.store.modules.graph(located.topic.id);
  const pack = located.node.content?.cardPack;
  return {
    module: located.node,
    entry: canEnter(graph, moduleId, completedSet(graph)),
    prediction: predictionFor(svc.store, moduleId),
    warmUp: warmUpFor(svc.store, located.topic.id, moduleId),
    questions: lessonQuestionsFor(svc.store, located.topic.id, moduleId),
    calibration: calibrationFor(svc.store, moduleId),
    contentIssue: located.node.content === null ? contentIssueFor(svc.dataRoot, located.topic.id, moduleId) : null,
    cardPackDeck: pack === undefined ? null : findPackDeck(svc.store, pack.name, located.topic.id),
  };
}

/**
 * WHY: "generate" means the same button before and after the outline exists. C4 splits
 * it into two entry points — research first, then the writing pass over the outline it
 * produced — so the API picks the one that matches the topic's current state and never
 * invents a third path.
 */
export function startGeneration(svc: Services, topicId: TopicId): Job {
  const topic = svc.store.topics.get(topicId);
  if (topic === null || 'degraded' in topic) {
    throw err('not-found', { detail: 'generate requested for an unknown or degraded topic', userMessage: 'We could not find that subject.' });
  }
  if (svc.store.modules.graph(topicId).nodes.length === 0) {
    return svc.orchestrator.enqueueTopic(topicId);
  }
  // The learner pressing the button is a fresh start for the background recovery loop: the
  // attempts it spent on its own are not charged against the pass they asked for. It goes
  // here rather than in `resumeGeneration` because the sweep resumes through that same
  // method, and resetting there would hand the loop an unlimited budget.
  resetPrepAttempts(svc.dataRoot, topicId);
  return svc.orchestrator.resumeGeneration(topicId);
}
