// FRACTAL: implements F1, F5 | component C10
import type { QueueEntry, QueueView } from '@/shapes';

/**
 * The words on the queue screen, apart from React so they can be read and tested as
 * sentences.
 *
 * WHY none of them says "job", "queued", "dispatched" or "worker": those are the names of
 * the machinery, and the person reading this screen is waiting for a lesson, not
 * administering a system. Every line below answers one of two questions — is anything
 * happening, and how long has this been going.
 */

export const QUEUE_TITLE = 'What the app is working on';
export const QUEUE_INTRO =
  'Writing lessons happens in the background, one piece of work at a time. This is what has been asked for and what has been done.';
export const QUEUE_EMPTY = 'Nothing has been asked for yet. When you start a subject, the work shows up here.';
export const QUEUE_IDLE = 'Nothing waiting — everything asked for has been finished.';
export const QUEUE_REFRESH_LABEL = 'Check again';
export const QUEUE_UNAVAILABLE = 'The list of work could not be read just now.';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The one line at the top: what is happening right now, in a sentence. */
export function queueSummary(view: QueueView): string {
  if (view.entries.length === 0) return QUEUE_EMPTY;
  if (view.running === 0 && view.waiting === 0) return QUEUE_IDLE;
  // WHY these three are written out rather than assembled from fragments: "3 more waiting"
  // with nothing running is more than what, and a sentence that has to be parsed twice is
  // worse than three sentences.
  if (view.running === 0) return `${plural(view.waiting, 'thing', 'things')} waiting to be written.`;
  if (view.waiting === 0) return `${plural(view.running, 'thing', 'things')} being written now.`;
  return `${plural(view.running, 'thing', 'things')} being written now, ${view.waiting} more waiting.`;
}

/**
 * What this piece of work is, named by what the learner would call it.
 *
 * WHY a whole-subject pass is not always "planning": one job kind covers both halves of
 * generation, and which half runs depends on whether the subject already has an outline.
 * Calling all of them planning meant a subject whose plan was on screen — every lesson
 * named, several of them written — showed "Planning the lessons for X" in the queue each
 * time a pass came back for the lessons still unwritten. The learner is watching the app
 * plan a curriculum it planned days ago, over and over. It is writing, and says so.
 */
export function entryTitle(entry: QueueEntry): string {
  if (entry.plansOutline) return `Planning the lessons for ${entry.subject}`;
  if (entry.kind === 'generate-topic') return `Writing more lessons for ${entry.subject}`;
  if (entry.lessonTitle === null) return `Writing a lesson for ${entry.subject}`;
  if (entry.kind === 'extend') return `Planning more lessons for ${entry.subject}`;
  if (entry.kind === 'detour') return `Writing a detour: ${entry.lessonTitle}`;
  return `Writing “${entry.lessonTitle}”`;
}

export function entryState(entry: QueueEntry): string {
  if (entry.status === 'queued') return 'waiting its turn';
  if (entry.status === 'running') return 'being written now';
  if (entry.status === 'succeeded') return 'done';
  if (entry.status === 'cancelled') return 'stopped';
  return 'did not finish';
}

/**
 * WHY minutes and not a clock time: "started at 14:03" makes the reader do the subtraction,
 * and the only thing they wanted was the answer to it. Under a minute is "just now"
 * because a number that changes while you read it reads as broken.
 */
export function ago(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${plural(minutes, 'minute', 'minutes')} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${plural(hours, 'hour', 'hours')} ago`;
  return `${plural(Math.floor(hours / 24), 'day', 'days')} ago`;
}

/** The second line of an entry: where it is in its life, and when that happened. */
export function entryTiming(entry: QueueEntry, now: Date = new Date()): string {
  if (entry.status === 'queued') return `asked for ${ago(entry.queuedAt, now)}`;
  if (entry.status === 'running') {
    return `started ${ago(entry.startedAt ?? entry.queuedAt, now)}`;
  }
  return `finished ${ago(entry.finishedAt ?? entry.queuedAt, now)}`;
}

/**
 * WHY a second attempt is worth a word: the same lesson appearing twice in this list looks
 * like a bug to the person reading it, and "tried twice" is the difference between the app
 * being stuck and the app having another go.
 */
export function attemptNote(entry: QueueEntry): string | null {
  if (entry.attempts <= 1) return null;
  return `tried ${entry.attempts} times`;
}

/** The whole detail line under an entry's title. */
export function entryDetail(entry: QueueEntry, now: Date = new Date()): string {
  const parts = [entryState(entry), entryTiming(entry, now)];
  const attempts = attemptNote(entry);
  if (attempts !== null) parts.push(attempts);
  return parts.join(' · ');
}
