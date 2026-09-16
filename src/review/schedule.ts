// FRACTAL: implements F7 | component C7
import type { AssistLevel, ISODateString, ModuleId, ReviewItem } from '@/shapes';
import { err } from '@/core/errors';
import { log } from '@/core/log';
import { nowIso } from '@/orchestrator/ids';
import type { Store } from '@/store/open';
import { moduleIndex } from '@/review/locate';
import { snapshotOf } from '@/store/reviews';
import {
  ASSISTED_THRESHOLD,
  DAY_MS,
  DEFAULT_SCHEDULE_PARAMS,
  firstSchedule,
  gradeForCompletion,
  gradeForSelfReport,
  gradeForVerdict,
  nextSchedule,
  retrievability,
  type ReviewGrade,
} from '@/review/memory';
import { scheduleParamsSchema, type ScheduleParams } from '@/review/shapes';

export { scheduleParamsSchema };
export type { ScheduleParams };
export {
  ASSISTED_THRESHOLD,
  DAY_MS,
  DEFAULT_SCHEDULE_PARAMS,
  gradeForCompletion,
  gradeForSelfReport,
  gradeForVerdict,
  retrievability,
};
export type { ReviewGrade };

// Any fixed instant works: first intervals depend only on the grade, never on the date.
const EPOCH = '2030-01-01T00:00:00.000Z' as ISODateString;

/**
 * The first interval a pass at this assist level earns, in days.
 *
 * This is now *derived* from the memory model rather than configured: an unassisted pass is
 * graded `good` and FSRS-6's initial stability for `good` puts it 3 days out, an
 * assisted-pass is graded `hard` and lands 2 days out. F7's rule that an assisted-pass
 * starts sooner holds because the model says so, not because a constant says so — and
 * unlike the old constant, the shortening persists into later intervals, because `hard`
 * also sets a higher initial difficulty.
 */
export function firstIntervalDays(assist: AssistLevel, params: ScheduleParams = DEFAULT_SCHEDULE_PARAMS): number {
  return firstSchedule(gradeForCompletion(assist), EPOCH, params).intervalDays;
}

// WHY (F7 AC): the cap is a maximum interval, never an exit — the next due
// instant is always a finite instant, so a module at the cap still resurfaces.
export function dueAtFrom(now: ISODateString, intervalDays: number): ISODateString {
  return new Date(Date.parse(now) + intervalDays * DAY_MS)
    .toISOString()
    .replace(/(\.\d{3})\d*Z$/, '$1Z') as ISODateString;
}

export function scheduledOnCompletion(
  moduleId: ModuleId,
  assist: AssistLevel,
  now: ISODateString,
  params: ScheduleParams = DEFAULT_SCHEDULE_PARAMS,
): ReviewItem {
  const scheduled = firstSchedule(gradeForCompletion(assist), now, params);
  return {
    moduleId,
    dueAt: scheduled.dueAt,
    intervalDays: scheduled.intervalDays,
    lapses: 0,
    lastAssistLevel: assist,
    flaggedNeedsReview: false,
    memory: scheduled.memory,
  };
}

/**
 * Advance an item by one graded retrieval.
 *
 * WHY a miss no longer resets the interval to 1 day: FSRS's post-lapse stability remembers
 * how strong the memory was before the miss, so forgetting something you had held for four
 * months does not put it back where a brand-new lesson starts. And WHY there is no ease
 * penalty any more: difficulty mean-reverts, which is the fix for the ease hell the old
 * monotonically-decreasing `ease` produced — an item the learner missed twice a year ago and
 * has since answered correctly ten times should not still be paying for it.
 */
export function advanced(
  item: ReviewItem,
  grade: ReviewGrade,
  now: ISODateString,
  params: ScheduleParams = DEFAULT_SCHEDULE_PARAMS,
): ReviewItem {
  const scheduled = nextSchedule(
    { memory: item.memory, dueAt: item.dueAt, intervalDays: item.intervalDays, lapses: item.lapses },
    grade,
    now,
    params,
  );
  return {
    ...item,
    intervalDays: scheduled.intervalDays,
    dueAt: scheduled.dueAt,
    lapses: scheduled.lapsed ? item.lapses + 1 : item.lapses,
    flaggedNeedsReview: scheduled.lapsed,
    memory: scheduled.memory,
  };
}

export function scheduleOnCompletion(
  store: Store,
  moduleId: ModuleId,
  assist: AssistLevel,
  now: ISODateString = nowIso(),
  params: ScheduleParams = DEFAULT_SCHEDULE_PARAMS,
): ReviewItem {
  const item = scheduledOnCompletion(moduleId, assist, now, params);
  store.reviews.upsert(item, {
    moduleId,
    reviewedAt: now,
    grade: gradeForCompletion(assist),
    before: null,
    after: snapshotOf(item),
  });
  log({ level: 'info', event: 'review-scheduled', component: 'C7', moduleId, intervalDays: item.intervalDays });
  return item;
}

/**
 * Record a graded retrieval against a module already in the schedule.
 *
 * `grade` is the only place the evaluator's judgement enters the memory model; the mapping
 * from our outcomes onto it lives in `@/review/memory` and is argued in
 * `docs/spaced-repetition.md` §3.
 */
export function recordGradedReview(
  store: Store,
  moduleId: ModuleId,
  grade: ReviewGrade,
  now: ISODateString = nowIso(),
  params: ScheduleParams = DEFAULT_SCHEDULE_PARAMS,
): ReviewItem {
  const existing = store.reviews.get(moduleId);
  if (existing === null) {
    throw err('not-found', {
      detail: 'recordReview for a module that has never been scheduled',
      userMessage: 'That lesson is not in your review list.',
    });
  }
  const next = advanced(existing, grade, now, params);
  store.reviews.upsert(next, {
    moduleId,
    reviewedAt: now,
    grade,
    before: snapshotOf(existing),
    after: snapshotOf(next),
  });
  // WHY (F7): a miss re-flags the lesson so the dashboard shows it needs another
  // look; a lesson that no longer exists simply has nothing to re-flag.
  if (grade === 'again') {
    const located = moduleIndex(store).get(moduleId);
    if (located !== undefined && located.node.state !== 'needs-review') {
      store.modules.setState(moduleId, 'needs-review');
    }
  }
  log({
    level: 'info',
    event: 'review-recorded',
    component: 'C7',
    moduleId,
    grade,
    intervalDays: next.intervalDays,
  });
  return next;
}

/**
 * The self-reported path: the dashboard's two buttons, and F8 practice answers. A binary
 * signal carries no information that could distinguish `hard` from `good`, so it does not
 * pretend to.
 */
export function recordReview(
  store: Store,
  moduleId: ModuleId,
  correct: boolean,
  now: ISODateString = nowIso(),
  params: ScheduleParams = DEFAULT_SCHEDULE_PARAMS,
): ReviewItem {
  return recordGradedReview(store, moduleId, gradeForSelfReport(correct), now, params);
}
