// FRACTAL: implements F7 | component C7
/**
 * The memory model behind F7's schedule: FSRS-6, via `ts-fsrs`.
 *
 * WHY this module has no store and no clock of its own: it is the one piece C1's
 * `completeModule` transaction needs (a module pass is where the first review is
 * scheduled), and C7 depends on C1 rather than the other way round. Keeping the model
 * pure — every input passed in, every output returned — lets C1 call it without a cycle,
 * and is also what makes scheduling deterministic and testable with no provider call.
 *
 * The research this implements, including the parts of FSRS we deliberately did not take,
 * is written up in `docs/spaced-repetition.md`.
 */
import { createEmptyCard, fsrs, Rating, State, type Card, type FSRS, type Grade } from 'ts-fsrs';
import {
  isoDateStringSchema,
  scheduleParamsSchema,
  type AssistLevel,
  type EvalVerdict,
  type ISODateString,
  type ReviewMemory,
  type ScheduleParams,
} from '@/shapes';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** F4's boundary: at or above this the pass was bought with help and counts as `assisted-pass`. */
export const ASSISTED_THRESHOLD: AssistLevel = 2;

export const DEFAULT_SCHEDULE_PARAMS: ScheduleParams = scheduleParamsSchema.parse({
  requestRetention: 0.9,
  maxIntervalDays: 180,
  minIntervalDays: 1,
});

/**
 * Our grade vocabulary. Three values, not FSRS's four.
 *
 * WHY no `easy`: the benchmark finds FSRS fits *better* on mostly-Again/Good histories than
 * on four-button ones, because Hard and Easy are where grade noise concentrates. We have no
 * signal that honestly means "easier than expected" — the nearest candidate, F10's predicted
 * confidence, is a claim about the learner's expectations, not evidence about this
 * retrieval. And the case Easy exists for is already covered: a badly overdue item answered
 * correctly earns a large stability gain on its own, because the recall term scales with
 * (1 - retrievability). See `docs/spaced-repetition.md` §3.
 */
export type ReviewGrade = 'again' | 'hard' | 'good';

const RATING: Record<ReviewGrade, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
};

/**
 * The first schedule, set when F4 passes a module.
 *
 * WHY this never returns `again`, even at assist level 3: completion is an encoding event,
 * not a retrieval attempt — there was no memory to fail to retrieve. Grading it as a lapse
 * would record a failure in the item's history before the item has any history. Heavy help
 * caps out at `hard`, which is what F7's "an assisted-pass starts on a shorter first
 * interval" means once it is expressed in the model rather than as a constant.
 */
export function gradeForCompletion(assist: AssistLevel): ReviewGrade {
  return assist >= ASSISTED_THRESHOLD ? 'hard' : 'good';
}

/**
 * A review answered through C6's evaluator chat, where we have the full verdict.
 *
 * WHY `assisted-pass` is `hard` and not `again`: FSRS treats Again as a lapse — it
 * increments the lapse count and routes through the post-forgetting stability formula. An
 * assisted pass *is* a pass; the learner got there. Hard is FSRS's passing-but-effortful
 * grade and is exactly the right encoding. This is information the old scheduler threw
 * away: it multiplied by `ease` no matter how much help the pass took.
 */
export function gradeForVerdict(outcome: EvalVerdict['outcome'], assist: AssistLevel): ReviewGrade {
  if (outcome === 'fail') return 'again';
  if (outcome === 'assisted-pass' || assist >= ASSISTED_THRESHOLD) return 'hard';
  return 'good';
}

/**
 * A queue card marked "I remembered this" / "I had forgotten this", and an F8 practice
 * answer. Binary in, binary out — there is nothing here to distinguish `hard` from `good`.
 */
export function gradeForSelfReport(correct: boolean): ReviewGrade {
  return correct ? 'good' : 'again';
}

export type Scheduled = {
  intervalDays: number;
  dueAt: ISODateString;
  memory: ReviewMemory;
  /** True when this retrieval was graded `again`, i.e. the caller should count a lapse. */
  lapsed: boolean;
};

/**
 * WHY `enable_short_term: false`: learning steps are sub-hour, intra-session constructs for
 * flashcard drilling; our smallest interval is a day. It also makes F8 safe. With short-term
 * steps off, a second retrieval on the same UTC day takes the ordinary recall path with
 * elapsed time 0, so retrievability is 1, so the stability gain term e^(w10*(1-R)) - 1 is
 * exactly zero and stability is unchanged — while a same-day *miss* still goes through the
 * forgetting branch and still pulls the schedule in. Five practice questions from one module
 * in one sitting cannot inflate that module's interval; one wrong answer still shortens it.
 *
 * WHY `enable_fuzz: false`: fuzz randomises intervals by a few percent to spread Anki's
 * daily load. C7 already spreads load with REVIEW_DAILY_CAP, and F7 requires scheduling to
 * be deterministic and reproducible in a test. Randomness buys nothing and costs that.
 *
 * WHY `maximum_interval` is set well past our cap and the cap is applied here instead:
 * ts-fsrs's long-term scheduler enforces `good >= hard + 1` *after* clamping, so passing
 * 180 can return 181. F7 states the cap as an invariant, so we hold it ourselves.
 */
function engine(params: ScheduleParams): FSRS {
  return fsrs({
    request_retention: params.requestRetention,
    maximum_interval: params.maxIntervalDays,
    enable_fuzz: false,
    enable_short_term: false,
  });
}

function isoAt(epochMs: number): ISODateString {
  return isoDateStringSchema.parse(new Date(epochMs).toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z'));
}

/**
 * WHY the due instant is recomputed from `now + intervalDays` rather than read off the
 * card: ts-fsrs rounds the card's due date onto a day boundary, and our due query compares
 * exact ISO instants. Deriving it keeps "due in N days" literally true and keeps the cap
 * exact.
 */
function scheduledFrom(card: Card, now: ISODateString, params: ScheduleParams, lapsed: boolean): Scheduled {
  const raw = Math.round((card.due.getTime() - Date.parse(now)) / DAY_MS);
  const intervalDays = Math.min(params.maxIntervalDays, Math.max(params.minIntervalDays, raw));
  return {
    intervalDays,
    dueAt: isoAt(Date.parse(now) + intervalDays * DAY_MS),
    memory: {
      stability: round4(card.stability),
      difficulty: round4(card.difficulty),
      reps: card.reps,
      lastReviewedAt: now,
    },
    lapsed,
  };
}

// Four decimals is far finer than a day of scheduling resolution and keeps the stored
// numbers stable across a round-trip through SQLite's REAL.
function round4(n: number): number {
  return Number(n.toFixed(4));
}

/** The very first schedule for a module, from an empty memory. */
export function firstSchedule(
  grade: ReviewGrade,
  now: ISODateString,
  params: ScheduleParams = DEFAULT_SCHEDULE_PARAMS,
): Scheduled {
  const at = new Date(Date.parse(now));
  const { card } = engine(params).next(createEmptyCard(at), at, RATING[grade]);
  return scheduledFrom(card, now, params, grade === 'again');
}

/**
 * WHY `last_review` falls back to the due instant minus the interval: rows migrated from the
 * old ease-based scheduler have no recorded review instant, and FSRS needs elapsed time to
 * know how much the memory had decayed. The old scheduler's own interval is the best
 * available estimate of when that item was last seen.
 *
 * WHY it is then clamped to `now`: FSRS throws on a negative elapsed time, and a review can
 * legitimately arrive with an earlier instant than the last one — the host clock steps
 * backwards over a DST or NTP correction, or a queued request lands out of order. Clamping
 * makes that case behave exactly like the same-day retrieval described above: elapsed 0, so
 * retrievability 1, so a correct answer changes nothing and a miss still pulls the schedule
 * in. Refusing the review outright would lose the learner's answer over a clock artefact.
 */
function toCard(
  memory: ReviewMemory,
  dueAt: ISODateString,
  intervalDays: number,
  lapses: number,
  now: ISODateString,
): Card {
  const fallback = isoAt(Date.parse(dueAt) - intervalDays * DAY_MS);
  const lastReview = Math.min(Date.parse(memory.lastReviewedAt ?? fallback), Date.parse(now));
  return {
    due: new Date(Date.parse(dueAt)),
    stability: memory.stability,
    difficulty: memory.difficulty,
    elapsed_days: 0,
    scheduled_days: intervalDays,
    learning_steps: 0,
    reps: memory.reps,
    lapses,
    state: State.Review,
    last_review: new Date(lastReview),
  };
}

export type MemoryAt = {
  memory: ReviewMemory;
  dueAt: ISODateString;
  intervalDays: number;
  lapses: number;
};

/** Advance an existing item by one graded retrieval. */
export function nextSchedule(
  at: MemoryAt,
  grade: ReviewGrade,
  now: ISODateString,
  params: ScheduleParams = DEFAULT_SCHEDULE_PARAMS,
): Scheduled {
  const when = new Date(Date.parse(now));
  const card = toCard(at.memory, at.dueAt, at.intervalDays, at.lapses, now);
  const { card: next } = engine(params).next(card, when, RATING[grade]);
  return scheduledFrom(next, now, params, grade === 'again');
}

/**
 * Probability of recall right now, in [0, 1]. Internal only: this is a review cue for
 * ordering and logging, never a number the learner is shown. F5 forbids progress expressed
 * as a grade and "you have a 78% chance of remembering this" is a grade.
 */
export function retrievability(
  at: MemoryAt,
  now: ISODateString,
  params: ScheduleParams = DEFAULT_SCHEDULE_PARAMS,
): number {
  const card = toCard(at.memory, at.dueAt, at.intervalDays, at.lapses, now);
  return engine(params).get_retrievability(card, new Date(Date.parse(now)), false);
}

/**
 * The difficulty FSRS-6 assigns a first pass graded `good` — the anchor the legacy `ease`
 * migration interpolates from. Read off the algorithm rather than written down, so a
 * `ts-fsrs` upgrade cannot silently desync it from the migration.
 */
export function initialDifficultyForGood(params: ScheduleParams = DEFAULT_SCHEDULE_PARAMS): number {
  return firstSchedule('good', isoDateStringSchema.parse('2030-01-01T00:00:00.000Z'), params).memory.difficulty;
}

/** The old scheduler's constants, kept only so its rows can be read into the new model. */
export const LEGACY_START_EASE = 2.5;
export const LEGACY_MIN_EASE = 1.3;

/**
 * Read an ease-based row into a DSR memory state, for the migration.
 *
 * Stability seeds from the stored interval because the two share units and meaning: FSRS
 * defines stability as the interval at which recall probability reaches 0.9, and the old
 * scheduler's interval was its own estimate of when the item next needed revisiting.
 *
 * Difficulty interpolates the old `ease` between its two fixed points: 2.5 is the start
 * value, only ever reached by an item that has never lapsed, which is FSRS's `good`-graded
 * card; 1.3 is the floor, only reached after eight lapses, which is FSRS's maximum
 * difficulty. A learner mid-course keeps their schedule instead of restarting it.
 */
export function memoryFromLegacy(
  legacy: { intervalDays: number; ease: number },
  params: ScheduleParams = DEFAULT_SCHEDULE_PARAMS,
): ReviewMemory {
  const easiest = initialDifficultyForGood(params);
  const span = LEGACY_START_EASE - LEGACY_MIN_EASE;
  const fraction = Math.min(1, Math.max(0, (LEGACY_START_EASE - legacy.ease) / span));
  return {
    stability: round4(Math.max(0.001, legacy.intervalDays)),
    difficulty: round4(Math.min(10, Math.max(1, easiest + fraction * (10 - easiest)))),
    reps: 1,
    lastReviewedAt: null,
  };
}
