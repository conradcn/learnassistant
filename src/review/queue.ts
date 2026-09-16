// FRACTAL: implements F7 | component C7
import type { ISODateString, ModuleId, ReviewItem, TopicId } from '@/shapes';
import { log } from '@/core/log';
import { nowIso } from '@/orchestrator/ids';
import type { Store } from '@/store/open';
import { moduleIndex } from '@/review/locate';

export type ReviewCard = {
  item: ReviewItem;
  moduleId: ModuleId;
  topicId: TopicId;
  moduleTitle: string;
  topicSubject: string;
  needsAnotherLook: boolean;
};

export type ReviewQueue = {
  cards: ReviewCard[];
  dueTotal: number;
  shown: number;
  dailyCap: number;
  header: string;
  droppedCount: number;
  blocksOtherWork: false;
};

const OVERFETCH = 2;

// WHY (bounded queue): the backlog scan is capped so a long absence cannot turn
// the dashboard read into an unbounded row load.
export const MAX_QUEUE_SCAN = 5000;

/**
 * How many due reviews are offered in one day. C7's own number: a backlog after a long
 * absence is shown a day at a time rather than all at once (F7), and the rest stays in
 * the queue. It bounds a batch, not a spend — nothing is refused for it.
 */
export const REVIEW_DAILY_CAP = 200;

export function due(store: Store, now: ISODateString = nowIso(), limit: number = REVIEW_DAILY_CAP): ReviewItem[] {
  const bounded = Math.max(0, Math.floor(limit));
  if (bounded === 0) return [];
  const index = moduleIndex(store);
  const rows = store.reviews.due(now, bounded * OVERFETCH);
  const live = rows.filter((item) => {
    if (index.has(item.moduleId)) return true;
    // WHY (failure & recovery): a review pointing at a deleted lesson is dropped
    // and logged rather than blocking the queue behind an item nobody can open.
    log({ level: 'warn', event: 'review-item-orphaned', component: 'C7', moduleId: item.moduleId });
    return false;
  });
  return live.slice(0, bounded);
}

export function dueCount(store: Store, now: ISODateString = nowIso()): number {
  const index = moduleIndex(store);
  return store.reviews.due(now, MAX_QUEUE_SCAN).filter((i) => index.has(i.moduleId)).length;
}

export function queueHeader(dueTotal: number, shown: number, cap: number): string {
  if (dueTotal === 0) return 'Nothing is due for review right now.';
  if (shown >= dueTotal) return `${dueTotal} ${dueTotal === 1 ? 'review is' : 'reviews are'} ready when you are.`;
  return `${dueTotal} due, showing today's ${shown} (daily limit ${cap}). The rest stays in the queue.`;
}

// WHY (F7 AC): this returns a list of optional cards and nothing else — there is
// no gate flag for a caller to read, so an overdue review cannot block anything.
export function reviewQueue(store: Store, now: ISODateString = nowIso(), limit: number = REVIEW_DAILY_CAP): ReviewQueue {
  const index = moduleIndex(store);
  const rows = store.reviews.due(now, MAX_QUEUE_SCAN);
  const live: ReviewItem[] = [];
  let dropped = 0;
  for (const item of rows) {
    if (index.has(item.moduleId)) {
      live.push(item);
      continue;
    }
    dropped += 1;
    log({ level: 'warn', event: 'review-item-orphaned', component: 'C7', moduleId: item.moduleId });
  }
  const cap = Math.max(0, Math.floor(limit));
  const batch = live.slice(0, cap);
  const cards: ReviewCard[] = batch.map((item) => {
    const located = index.get(item.moduleId);
    if (located === undefined) throw new Error('unreachable: filtered item lost its module');
    return {
      item,
      moduleId: item.moduleId,
      topicId: located.topic.id,
      moduleTitle: located.node.title,
      topicSubject: located.topic.subject,
      needsAnotherLook: item.flaggedNeedsReview,
    };
  });
  return {
    cards,
    dueTotal: live.length,
    shown: cards.length,
    dailyCap: cap,
    header: queueHeader(live.length, cards.length, cap),
    droppedCount: dropped,
    blocksOtherWork: false,
  };
}
