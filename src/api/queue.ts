// FRACTAL: implements F1, F5 | component C9
import { isoDateStringSchema, queueViewSchema, type QueueEntry, type QueueView } from '@/shapes';
import type { JobRecord } from '@/store/jobs';
import type { Services } from '@/api/services';

/**
 * How much of the queue is served. WHY there is a ceiling at all: the question this screen
 * answers is "is anything happening, and how long has it been waiting" — and that is
 * answered by what is in flight plus the last few things that finished. A month of history
 * is a different question, and nothing on this screen asks it.
 */
export const QUEUE_LIMIT = 20;

const UNKNOWN_SUBJECT = 'A subject that is no longer here';

function isPending(status: QueueEntry['status']): boolean {
  return status === 'queued' || status === 'running';
}

/**
 * WHY the order is not just "newest first": the rows a learner opened this screen for are
 * the ones still to happen, and burying them under this morning's successes is the screen
 * failing at its one job. Waiting and running work comes first, oldest at the top because
 * that is the order it will be done in; everything finished follows, most recent first.
 */
function byInterest(a: QueueEntry, b: QueueEntry): number {
  const pendingA = isPending(a.status);
  const pendingB = isPending(b.status);
  if (pendingA !== pendingB) return pendingA ? -1 : 1;
  if (pendingA) return a.queuedAt.localeCompare(b.queuedAt);
  return (b.finishedAt ?? b.queuedAt).localeCompare(a.finishedAt ?? a.queuedAt);
}

/**
 * The work the app has been asked to do, as the person waiting on it sees it.
 *
 * WHY this view exists: everything the app does for a subject after the learner presses a
 * button happens in a background queue they cannot see. When it is working, the only
 * evidence is a spinner on one page; when it is not, the evidence is the same spinner. A
 * learner who wanted to know whether anything was actually happening had to be told to
 * read a log file.
 */
export function queueView(svc: Services): QueueView {
  // WHY it is reversed before sorting: the store hands back the newest first so the cap
  // keeps the rows worth showing, but two pieces of work asked for in the same millisecond
  // — which is what a pass fanning out into a job per lesson does — compare equal below,
  // and a stable sort then leaves them in the order they arrived in. Oldest first is the
  // order they will actually be done in.
  const records = svc.store.jobs.recent(QUEUE_LIMIT).reverse();

  // One graph read per subject rather than one per job: a pass fans out into a job per
  // lesson, and they all belong to the same handful of subjects.
  const subjects = new Map<string, string>();
  for (const topic of svc.store.topics.list()) {
    subjects.set(topic.id, 'degraded' in topic ? UNKNOWN_SUBJECT : topic.subject);
  }
  // WHY the graph and not the job kind: a whole pass is one kind, `generate-topic`, and C4
  // decides between researching an outline and writing lessons into an existing one by
  // whether the store holds a graph — see `runGeneration`. Reading the same thing here is
  // what keeps this screen's words and that decision from drifting apart. Memoised per
  // subject for the same reason the lesson titles are: a pass is many jobs, one subject.
  const hasOutline = new Map<string, boolean>();
  const outlineExists = (topicId: string): boolean => {
    const known = hasOutline.get(topicId);
    if (known !== undefined) return known;
    const exists = svc.store.modules.graph(topicId as JobRecord['topicId']).nodes.length > 0;
    hasOutline.set(topicId, exists);
    return exists;
  };

  const lessonTitles = new Map<string, Map<string, string>>();
  const titleOf = (record: JobRecord): string | null => {
    if (record.moduleId === null) return null;
    let titles = lessonTitles.get(record.topicId);
    if (titles === undefined) {
      titles = new Map(svc.store.modules.graph(record.topicId).nodes.map((n) => [n.id as string, n.title]));
      lessonTitles.set(record.topicId, titles);
    }
    return titles.get(record.moduleId) ?? null;
  };

  const entries: QueueEntry[] = records.map((record) => ({
    id: record.id,
    kind: record.kind,
    status: record.status,
    topicId: record.topicId,
    subject: subjects.get(record.topicId) ?? UNKNOWN_SUBJECT,
    lessonTitle: titleOf(record),
    attempts: record.attempts,
    queuedAt: isoDateStringSchema.parse(record.queuedAt),
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    // WHY only the message: `AppErrorShape` also carries a code and a correlation id, and
    // neither is something the learner can act on. The correlation id is how a log line is
    // found, and the log is where it stays.
    errorMessage: record.error === null ? null : record.error.message,
    // WHY it is read now rather than recorded when the job ran: the entries that matter
    // here are the ones still waiting, and what they will do is decided when they are
    // picked up, from exactly this. A finished research pass on a subject that has since
    // been planned is described by what the pass left behind, which is the lessons.
    plansOutline: record.kind === 'generate-topic' && !outlineExists(record.topicId),
  }));

  entries.sort(byInterest);

  return queueViewSchema.parse({
    // WHY the count is asked of the table and not of the list above it: the list is capped,
    // and a summary that said "3 waiting" because that is all that fit on screen would be
    // wrong in exactly the situation the learner most needs it to be right.
    waiting: svc.store.jobs.queuedCount(),
    running: entries.filter((e) => e.status === 'running').length,
    entries,
  });
}
