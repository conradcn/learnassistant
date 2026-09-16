// FRACTAL: covers F7 | type unit
/**
 * The memory model itself, over simulated review histories. Everything here is pure —
 * no store, no clock, no provider — which is the point: F7 requires a schedule a test can
 * pin down exactly.
 *
 * The reasoning behind the mapping these tests assert is in `docs/spaced-repetition.md`.
 */
import { describe, expect, it } from 'vitest';
import { isoDateStringSchema, scheduleParamsSchema, type ISODateString } from '@/shapes';
import {
  ASSISTED_THRESHOLD,
  DEFAULT_SCHEDULE_PARAMS,
  firstSchedule,
  gradeForCompletion,
  gradeForSelfReport,
  gradeForVerdict,
  memoryFromLegacy,
  nextSchedule,
  retrievability,
  type MemoryAt,
  type ReviewGrade,
  type Scheduled,
} from '@/review/memory';

const START = isoDateStringSchema.parse('2030-01-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function day(n: number, from: ISODateString = START): ISODateString {
  return isoDateStringSchema.parse(new Date(Date.parse(from) + n * DAY).toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z'));
}

type Step = { grade: ReviewGrade; afterDays?: number };

/** Replay a history, always answering on the day the item came due unless told otherwise. */
function replay(first: ReviewGrade, steps: Step[]): { item: Scheduled; at: ISODateString; lapses: number } {
  let scheduled = firstSchedule(first, START);
  let now = START;
  let lapses = scheduled.lapsed ? 1 : 0;
  for (const step of steps) {
    const elapsed = step.afterDays ?? scheduled.intervalDays;
    now = day(elapsed, now);
    const at: MemoryAt = {
      memory: scheduled.memory,
      dueAt: scheduled.dueAt,
      intervalDays: scheduled.intervalDays,
      lapses,
    };
    scheduled = nextSchedule(at, step.grade, now);
    if (scheduled.lapsed) lapses += 1;
  }
  return { item: scheduled, at: now, lapses };
}

describe('F7 memory model: grade mapping', () => {
  it('maps a completion on how much help it took, and never onto a failure', () => {
    expect(gradeForCompletion(0)).toBe('good');
    expect(gradeForCompletion(1)).toBe('good');
    expect(gradeForCompletion(2)).toBe('hard');
    expect(gradeForCompletion(3)).toBe('hard');
    for (const assist of [0, 1, 2, 3] as const) {
      expect(gradeForCompletion(assist)).not.toBe('again');
    }
  });

  it('maps a review on the full verdict, because a review can actually fail', () => {
    expect(gradeForVerdict('pass', 0)).toBe('good');
    expect(gradeForVerdict('pass', 1)).toBe('good');
    expect(gradeForVerdict('assisted-pass', 0)).toBe('hard');
    expect(gradeForVerdict('assisted-pass', 3)).toBe('hard');
    expect(gradeForVerdict('pass', ASSISTED_THRESHOLD)).toBe('hard');
    expect(gradeForVerdict('fail', 0)).toBe('again');
    expect(gradeForVerdict('fail', 3)).toBe('again');
  });

  it('maps a binary self-report to the two grades a binary signal can support', () => {
    expect(gradeForSelfReport(true)).toBe('good');
    expect(gradeForSelfReport(false)).toBe('again');
  });

  it('never emits an "easy" grade from any input', () => {
    const grades: ReviewGrade[] = [
      ...([0, 1, 2, 3] as const).map(gradeForCompletion),
      ...(['pass', 'assisted-pass', 'fail'] as const).flatMap((o) =>
        ([0, 1, 2, 3] as const).map((a) => gradeForVerdict(o, a)),
      ),
      gradeForSelfReport(true),
      gradeForSelfReport(false),
    ];
    expect(new Set(grades)).toEqual(new Set(['again', 'hard', 'good']));
  });
});

describe('F7 memory model: simulated histories', () => {
  it('extends intervals for a learner who keeps remembering', () => {
    const first = firstSchedule('good', START);
    const { item } = replay('good', [{ grade: 'good' }, { grade: 'good' }, { grade: 'good' }]);
    expect(item.intervalDays).toBeGreaterThan(first.intervalDays);
    expect(item.memory.stability).toBeGreaterThan(first.memory.stability);
    expect(item.lapsed).toBe(false);
  });

  it('grows intervals sub-geometrically, unlike the ease multiplier it replaces', () => {
    // The old scheduler multiplied by a constant 2.5 forever. FSRS's stability gain shrinks
    // as stability grows — the spacing effect saturating.
    //
    // WHY the cap is lifted for this one: this asserts a property of the *model*, and the
    // real 180-day cap flattens the last ratios to exactly 1 long before the model itself
    // stops growing, which would make the test measure the clamp instead. The clamp has its
    // own test ('holds the maximum interval exactly').
    const params = scheduleParamsSchema.parse({ ...DEFAULT_SCHEDULE_PARAMS, maxIntervalDays: 36_500 });
    const intervals: number[] = [];
    let scheduled = firstSchedule('good', START, params);
    let now = START;
    const lapses = 0;
    for (let i = 0; i < 5; i += 1) {
      intervals.push(scheduled.intervalDays);
      now = day(scheduled.intervalDays, now);
      scheduled = nextSchedule(
        { memory: scheduled.memory, dueAt: scheduled.dueAt, intervalDays: scheduled.intervalDays, lapses },
        'good',
        now,
        params,
      );
    }
    const ratios = intervals.slice(1).map((v, i) => v / intervals[i]);
    expect(ratios.every((r) => r > 1)).toBe(true);
    expect(ratios[ratios.length - 1]).toBeLessThan(ratios[0]);
  });

  it('does not reset a long-held item to a beginner interval when it is finally missed', () => {
    // The old scheduler set the interval to 1 day on any miss. FSRS's post-lapse stability
    // remembers how strong the memory was.
    const held = replay('good', [{ grade: 'good' }, { grade: 'good' }, { grade: 'good' }, { grade: 'good' }]);
    const missed = replay('good', [
      { grade: 'good' },
      { grade: 'good' },
      { grade: 'good' },
      { grade: 'good' },
      { grade: 'again' },
    ]);
    const fresh = replay('good', [{ grade: 'again' }]);

    expect(missed.item.intervalDays).toBeLessThan(held.item.intervalDays);
    expect(missed.item.intervalDays).toBeGreaterThan(fresh.item.intervalDays);
    expect(missed.item.lapsed).toBe(true);
    expect(missed.lapses).toBe(1);
  });

  it('rewards a correct answer more when the item was overdue than when it was fresh', () => {
    // This is the case FSRS's `easy` button is usually reached for, and the reason we do
    // not need one: the stability gain already scales with (1 - retrievability).
    const onTime = replay('good', [{ grade: 'good' }]);
    const overdue = replay('good', [{ grade: 'good', afterDays: 30 }]);
    expect(overdue.item.memory.stability).toBeGreaterThan(onTime.item.memory.stability);
  });

  it('holds the maximum interval exactly, and still puts the item back in the queue', () => {
    const { item, at } = replay('good', Array.from({ length: 20 }, () => ({ grade: 'good' as const })));
    expect(item.intervalDays).toBe(DEFAULT_SCHEDULE_PARAMS.maxIntervalDays);
    expect(Date.parse(item.dueAt)).toBe(Date.parse(at) + DEFAULT_SCHEDULE_PARAMS.maxIntervalDays * DAY);
    expect(Number.isFinite(Date.parse(item.dueAt))).toBe(true);
  });

  it('never schedules anything sooner than the minimum interval', () => {
    const histories: ReviewGrade[][] = [
      ['again'],
      ['again', 'again'],
      ['again', 'again', 'again', 'again', 'again', 'again', 'again', 'again'],
      ['good', 'again', 'again', 'hard', 'again'],
    ];
    for (const history of histories) {
      const { item } = replay('good', history.map((grade) => ({ grade })));
      expect(item.intervalDays).toBeGreaterThanOrEqual(DEFAULT_SCHEDULE_PARAMS.minIntervalDays);
      expect(item.intervalDays).toBeLessThanOrEqual(DEFAULT_SCHEDULE_PARAMS.maxIntervalDays);
      expect(item.memory.difficulty).toBeGreaterThanOrEqual(1);
      expect(item.memory.difficulty).toBeLessThanOrEqual(10);
    }
  });

  it('keeps an assisted-pass history on shorter intervals than a clean one', () => {
    const clean = replay('good', [{ grade: 'good' }, { grade: 'good' }, { grade: 'good' }]);
    const helped = replay('hard', [{ grade: 'hard' }, { grade: 'hard' }, { grade: 'hard' }]);
    expect(helped.item.intervalDays).toBeLessThan(clean.item.intervalDays);
    // An assisted pass is a pass throughout: it never books a lapse.
    expect(helped.lapses).toBe(0);
    expect(helped.item.lapsed).toBe(false);
  });

  it('lets an assisted-pass item catch up once the help stops', () => {
    const helped = replay('hard', [{ grade: 'hard' }, { grade: 'good' }, { grade: 'good' }, { grade: 'good' }]);
    const stuck = replay('hard', [{ grade: 'hard' }, { grade: 'hard' }, { grade: 'hard' }, { grade: 'hard' }]);
    expect(helped.item.intervalDays).toBeGreaterThan(stuck.item.intervalDays);
    expect(helped.item.memory.difficulty).toBeLessThan(stuck.item.memory.difficulty);
  });

  it('is deterministic: identical histories produce byte-identical schedules', () => {
    const history: Step[] = [
      { grade: 'good' },
      { grade: 'hard' },
      { grade: 'again' },
      { grade: 'good' },
      { grade: 'good', afterDays: 40 },
    ];
    expect(replay('good', history)).toEqual(replay('good', history));
  });

  it('is stable under a request-retention change only in the direction you would expect', () => {
    const strict = scheduleParamsSchema.parse({ ...DEFAULT_SCHEDULE_PARAMS, requestRetention: 0.95 });
    const relaxed = scheduleParamsSchema.parse({ ...DEFAULT_SCHEDULE_PARAMS, requestRetention: 0.85 });
    expect(firstSchedule('good', START, strict).intervalDays).toBeLessThan(
      firstSchedule('good', START, relaxed).intervalDays,
    );
  });
});

describe('F7 memory model: same-day retrievals (F8 interleaved practice)', () => {
  // WHY this matters: F8 practice answers feed this scheduler, and a session can draw
  // several questions from one module. Under the old ease multiplier that pushed a 3-day
  // interval past 100 days in an afternoon.
  const base = firstSchedule('good', START);
  const at = (): MemoryAt => ({
    memory: base.memory,
    dueAt: base.dueAt,
    intervalDays: base.intervalDays,
    lapses: 0,
  });

  it('does not let repeated same-day correct answers inflate the schedule', () => {
    let scheduled = base;
    const lapses = 0;
    for (let i = 0; i < 5; i += 1) {
      const now = isoDateStringSchema.parse(`2030-01-01T0${i}:30:00.000Z`);
      scheduled = nextSchedule(
        { memory: scheduled.memory, dueAt: scheduled.dueAt, intervalDays: scheduled.intervalDays, lapses },
        'good',
        now,
      );
    }
    expect(scheduled.memory.stability).toBe(base.memory.stability);
    expect(scheduled.intervalDays).toBe(base.intervalDays);
    expect(lapses).toBe(0);
  });

  it('still registers a same-day miss', () => {
    const missed = nextSchedule(at(), 'again', isoDateStringSchema.parse('2030-01-01T06:00:00.000Z'));
    expect(missed.lapsed).toBe(true);
    expect(missed.memory.stability).toBeLessThan(base.memory.stability);
    expect(missed.intervalDays).toBeLessThanOrEqual(base.intervalDays);
  });
});

describe('F7 memory model: retrievability stays internal but stays right', () => {
  it('is near the target retention on the day an item comes due, and falls after', () => {
    const scheduled = firstSchedule('good', START);
    const at: MemoryAt = {
      memory: scheduled.memory,
      dueAt: scheduled.dueAt,
      intervalDays: scheduled.intervalDays,
      lapses: 0,
    };
    const onDue = retrievability(at, scheduled.dueAt);
    const later = retrievability(at, day(60, scheduled.dueAt));

    expect(onDue).toBeGreaterThan(0.8);
    expect(onDue).toBeLessThanOrEqual(1);
    expect(later).toBeLessThan(onDue);
    expect(later).toBeGreaterThan(0);
  });
});

describe('F7 memory model: reading the old ease-based rows', () => {
  it('seeds stability from the interval the old scheduler had reached', () => {
    expect(memoryFromLegacy({ intervalDays: 45, ease: 2.5 }).stability).toBe(45);
    expect(memoryFromLegacy({ intervalDays: 1, ease: 1.3 }).stability).toBe(1);
    // Guards against a divide-by-zero style collapse for a row with a nonsense interval.
    expect(memoryFromLegacy({ intervalDays: 0, ease: 2.5 }).stability).toBeGreaterThan(0);
  });

  it('maps the old ease onto difficulty at both fixed points and in between', () => {
    const easiest = memoryFromLegacy({ intervalDays: 10, ease: 2.5 }).difficulty;
    const hardest = memoryFromLegacy({ intervalDays: 10, ease: 1.3 }).difficulty;
    const middle = memoryFromLegacy({ intervalDays: 10, ease: 1.9 }).difficulty;

    expect(easiest).toBeCloseTo(firstSchedule('good', START).memory.difficulty, 4);
    expect(hardest).toBe(10);
    expect(middle).toBeGreaterThan(easiest);
    expect(middle).toBeLessThan(hardest);
  });

  it('clamps an out-of-range ease rather than producing an invalid memory state', () => {
    for (const ease of [5, 2.5, 1.3, 0, -1]) {
      const memory = memoryFromLegacy({ intervalDays: 10, ease });
      expect(memory.difficulty).toBeGreaterThanOrEqual(1);
      expect(memory.difficulty).toBeLessThanOrEqual(10);
    }
  });

  it('carries a migrated item forward without resetting its schedule', () => {
    // A learner four months into a course: interval 45 days, one earlier lapse.
    const memory = memoryFromLegacy({ intervalDays: 45, ease: 2.35 });
    const dueAt = day(45);
    const advanced = nextSchedule({ memory, dueAt, intervalDays: 45, lapses: 1 }, 'good', dueAt);

    expect(advanced.intervalDays).toBeGreaterThan(45);
    expect(advanced.lapsed).toBe(false);
    expect(advanced.memory.lastReviewedAt).toBe(dueAt);
  });
});

describe('F7 memory model: a clock that steps backwards', () => {
  /**
   * The host clock can move backwards between two reviews — a DST or NTP correction, or a
   * queued request landing out of order — and FSRS throws outright on a negative elapsed
   * time. The learner's answer must survive that, so `toCard` clamps the last review
   * instant to `now`. These pin the behaviour that clamp buys.
   */
  const earlier = day(-1, day(5));

  function afterOneReview(): MemoryAt {
    const first = firstSchedule('good', START);
    const scheduled = nextSchedule(
      { memory: first.memory, dueAt: first.dueAt, intervalDays: first.intervalDays, lapses: 0 },
      'good',
      day(5),
    );
    return {
      memory: scheduled.memory,
      dueAt: scheduled.dueAt,
      intervalDays: scheduled.intervalDays,
      lapses: 0,
    };
  }

  it('records a review dated before the last one instead of throwing', () => {
    const at = afterOneReview();
    expect(Date.parse(earlier)).toBeLessThan(Date.parse(at.memory.lastReviewedAt ?? START));

    const again = nextSchedule(at, 'good', earlier);

    expect(again.memory.lastReviewedAt).toBe(earlier);
    expect(again.memory.reps).toBe(at.memory.reps + 1);
    expect(Number.isFinite(again.intervalDays)).toBe(true);
    expect(again.intervalDays).toBeGreaterThan(0);
  });

  it('still pulls the schedule in when the backwards-dated answer is a miss', () => {
    const at = afterOneReview();
    const missed = nextSchedule(at, 'again', earlier);

    expect(missed.lapsed).toBe(true);
    expect(missed.intervalDays).toBeLessThan(at.intervalDays);
    expect(missed.memory.lastReviewedAt).toBe(earlier);
  });

  it('reads retrievability at a backwards-stepped instant without throwing', () => {
    const at = afterOneReview();
    const r = retrievability(at, earlier);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThanOrEqual(1);
  });
});
