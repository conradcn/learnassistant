// FRACTAL: implements F1 | component C9
import path from 'node:path';
import type { AppErrorShape } from '@/shapes';
import { AppError, err, toApiError } from '@/core/errors';
import { loadConfig } from '@/core/config';
import { log } from '@/core/log';
import { openStore, closeStore, type Store } from '@/store/open';
import { SessionRunner } from '@/cli/run-session';
import { Orchestrator, createOrchestrator } from '@/orchestrator/engine';
import { EvalEngine, createEvalEngine } from '@/eval/session';
import { createPracticeStore, type PracticeStore } from '@/practice/store';
import { ensureSessionToken } from '@/api/token';
import { PREP_SWEEP_INTERVAL_MS, sweepUnpreparedAvailable } from '@/orchestrator/prep-sweep';

export type Services = {
  dataRoot: string;
  store: Store;
  runner: SessionRunner;
  orchestrator: Orchestrator;
  engine: EvalEngine;
  practice: PracticeStore;
};

/**
 * WHY: module scope is not process scope here. Next bundles each route handler
 * separately, so every bundle got its own copy of this module and built its own
 * container — the logs showed `store-opened` several times in one run. That meant
 * several independent better-sqlite3 connections to the same file, several
 * `VACUUM INTO` snapshot writes racing at open, and several Orchestrator instances,
 * so a job enqueued by one was invisible to the pump in another.
 * `globalThis` is the only scope in the process that all bundles share.
 */
type Cell = {
  container: Services | null;
  failure: AppErrorShape | null;
  pumping: Promise<void> | null;
  wake: boolean;
  sweep: ReturnType<typeof setInterval> | null;
};

const CELL = Symbol.for('learn-assistant.api.services');

function cell(): Cell {
  const host = globalThis as unknown as Record<symbol, Cell | undefined>;
  const existing = host[CELL];
  if (existing !== undefined) return existing;
  const fresh: Cell = { container: null, failure: null, pumping: null, wake: false, sweep: null };
  host[CELL] = fresh;
  return fresh;
}

function build(): Services {
  const dataRoot = path.resolve(loadConfig().dataRoot);
  const store = openStore(dataRoot);
  const runner = new SessionRunner();
  const orchestrator = createOrchestrator({ store, runner, dataRoot });
  // WHY: jobs claimed as `running` by a process that died are owned by nobody. Until
  // this ran, they stayed `running` forever — `claimNext` only ever looks at `queued`,
  // so the row was invisible to the pump while the topic it belonged to stayed
  // `generating` in the UI. That is the queue "not draining" as the learner sees it.
  // First touch of the container is the only process-scoped boot hook on this path.
  // WHY the guard: reconciling is recovery, not a precondition. A failure here must
  // not be latched as `store-corrupt` and answered to every later request.
  try {
    orchestrator.resetRunningJobsAtBoot();
  } catch (e) {
    log({
      level: 'warn',
      event: 'api-boot-reset-failed',
      component: 'C9',
      cause: e instanceof Error ? e.message : String(e),
    });
  }
  const engine = createEvalEngine({ store, runner, dataRoot, orchestrator });
  return { dataRoot, store, runner, orchestrator, engine, practice: createPracticeStore() };
}

/**
 * WHY: one process-lifetime container. The store opens once at first touch and a
 * failure is remembered as an AppError shape, so every later request answers
 * `store-corrupt` instead of retrying a broken database on the request path.
 */
export function services(): Services | null {
  const c = cell();
  if (c.container !== null) return c.container;
  if (c.failure !== null) return null;
  try {
    ensureSessionToken();
    c.container = build();
    log({ level: 'info', event: 'api-services-ready', component: 'C9' });
    // WHY: boot recovery hands jobs back to `queued`, and nothing else in the process
    // drives the orchestrator — the pump only ran from routes that enqueue. A job
    // requeued at boot therefore waited for an unrelated POST that might never come,
    // which is the queue not draining exactly where the learner is most likely to be
    // looking: the first page load after a restart.
    pumpJobs(c.container);
    startPrepSweep(c.container);
    return c.container;
  } catch (e) {
    c.failure = toApiError(e);
    log({ level: 'error', event: 'api-services-failed', component: 'C9', correlationId: c.failure.correlationId });
    return null;
  }
}

/**
 * WHY: enqueueing a job is not running it. Nothing else in the process drives the
 * orchestrator, so a confirmed job sat in `queued` forever and the subject stayed
 * stuck. Every route that enqueues calls this; the single in-flight promise means a
 * second call joins the drain already running instead of claiming jobs beside it.
 * Fire-and-forget on purpose — the response carries the job, not its result.
 */
export function pumpJobs(svc: Services): void {
  const c = cell();
  // WHY: a lost wakeup. `drain` stops the moment `claimNext` returns null, but
  // `pumping` is not cleared until its `finally` runs a microtask later. A job
  // enqueued in that window saw a non-null `pumping`, returned early, and was left
  // `queued` with nobody coming back for it — until some unrelated POST happened to
  // pump again. The flag records the request so the running pump drains once more.
  if (c.pumping !== null) {
    c.wake = true;
    return;
  }
  c.pumping = (async () => {
    try {
      do {
        c.wake = false;
        await svc.orchestrator.drain();
      } while (c.wake);
    } catch (e) {
      log({
        level: 'error',
        event: 'job-pump-failed',
        component: 'C9',
        cause: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? (e.stack ?? null) : null,
      });
    } finally {
      c.pumping = null;
      c.wake = false;
    }
  })();
}

/**
 * WHY a background task and not another route hook: the lessons a learner has unlocked but
 * nobody has written are only noticed today on the turn that unlocks them. Anything that
 * interrupts that moment — a restart, a failed pass later retried, a window that deferred
 * lessons since unlocked — leaves the subject with an available lesson and an empty page,
 * waiting on the learner to press the button. This is the thing that comes back for them.
 *
 * It runs once at boot and then on an interval; `unref` keeps it from holding the process
 * open, and the guard means the several route bundles that share this cell start one timer
 * between them, not one each.
 *
 * It is also the queue's heartbeat: the same tick pumps whenever the jobs table has
 * anything left in `queued`, which is what makes draining level-triggered rather than
 * dependent on a request arriving at the right moment.
 */
export function startPrepSweep(svc: Services): void {
  const c = cell();
  if (c.sweep !== null) return;
  const run = (): void => {
    let queued = false;
    try {
      const result = sweepUnpreparedAvailable(svc);
      queued = result.queued > 0;
    } catch (e) {
      // WHY swallowed: this is unasked-for work on a timer with no request to fail. A
      // subject that cannot take a pass right now must not stop the sweep reaching the rest.
      log({
        level: 'error',
        event: 'prep-sweep-failed',
        component: 'C9',
        cause: e instanceof Error ? e.message : String(e),
      });
    }
    // WHY the queue is asked and not just this sweep's own result: the pump is
    // edge-triggered — it runs because some request enqueued something — and every way
    // that edge can be lost ends with rows sitting in `queued` and nobody coming back
    // for them. A drain that threw part-way clears its guard and stops with the rest of
    // the queue untouched; a job requeued at boot in a bundle that never gets another
    // POST waits on one; a job enqueued by a path whose route forgot to pump waits
    // forever. All of them look the same to the learner: "Planning your lessons…" that
    // never finishes, until some unrelated click happens to pump again. Asking the
    // table on the interval makes this level-triggered, so the queue drains on its own
    // within one sweep no matter which edge was dropped. An idle app still stays idle —
    // an empty queue pumps nothing.
    // WHY outside the sweep's own try: the heartbeat is the thing that must survive. A
    // subject that cannot be swept must not also cost every other subject its drain.
    try {
      if (queued || svc.store.jobs.queuedCount() > 0) pumpJobs(svc);
    } catch (e) {
      log({
        level: 'error',
        event: 'job-heartbeat-failed',
        component: 'C9',
        cause: e instanceof Error ? e.message : String(e),
      });
    }
  };
  const timer = setInterval(run, PREP_SWEEP_INTERVAL_MS);
  timer.unref?.();
  c.sweep = timer;
  run();
}

export function storeFailure(): AppErrorShape | null {
  services();
  return cell().failure;
}

export function requireStore(): Services {
  const ready = services();
  if (ready !== null) return ready;
  const known = cell().failure;
  if (known === null) {
    throw err('store-corrupt', { detail: 'services unavailable for an unrecorded reason' });
  }
  throw new AppError(known.code, known.message, known.correlationId);
}

export function resetServices(): void {
  const c = cell();
  const existing = c.container;
  if (c.sweep !== null) clearInterval(c.sweep);
  c.sweep = null;
  c.pumping = null;
  c.wake = false;
  c.container = null;
  c.failure = null;
  if (existing !== null) {
    existing.runner.cancelAll();
    closeStore(existing.dataRoot);
  }
}
