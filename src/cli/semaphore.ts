// FRACTAL: implements F6 | component C2

/**
 * Which kind of work is asking for a permit.
 *
 * WHY it is a property of the wait and not of the caller: the runner is the only place
 * that sees every session, so it is the only place that can tell "a learner is sitting in
 * front of this one" from "the app is writing ahead of them". C0's `roleOfKind` already
 * draws that line for model choice; this is the same line drawn for queueing.
 */
export type SessionPriority = 'interactive' | 'background';

type Waiter = { priority: SessionPriority; start: () => void };

/**
 * WHY the headroom is one and not the whole limit: an interactive session is a single
 * turn a person is waiting on, and there is at most a handful of them, so letting one
 * run above the limit costs the provider a fraction of what the writing fan-out already
 * spends — while a strict limit costs the learner the full length of whatever authoring
 * session happens to hold the slots.
 */
const INTERACTIVE_HEADROOM = 1;

// WHY: `config.sessionConcurrency` bounds how many provider sessions this app has open at
// once. The permit is released on every exit path, including a throw, so a failing session
// can never wedge the queue.
//
// WHY it is not plain FIFO (F6 / learner latency): background authoring is queued in whole
// fan-outs — one `generate-topic` puts every unwritten module in the queue at once — and
// each of those sessions runs for minutes. A learner's evaluation turn joining the tail of
// that queue waits for the entire batch, which on a real topic is over half an hour of a
// blank screen with the answer already saved and nothing to press. Interactive work
// therefore goes to the front and has a permit of its own above the limit; background work
// keeps the limit it always had, and still never starves, because it is only ever
// overtaken by the few turns a person is actually waiting for.
export class Semaphore {
  private readonly limit: number;
  private active = 0;
  private readonly waiting: Waiter[] = [];

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  private capFor(priority: SessionPriority): number {
    return priority === 'interactive' ? this.limit + INTERACTIVE_HEADROOM : this.limit;
  }

  private acquire(priority: SessionPriority): Promise<void> {
    if (this.active < this.capFor(priority)) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const waiter: Waiter = {
        priority,
        start: () => {
          this.active += 1;
          resolve();
        },
      };
      // Interactive waits go ahead of background ones and behind each other, so priority
      // reorders the queue without ever reordering work of the same kind.
      const ahead = priority === 'interactive' ? this.waiting.findIndex((w) => w.priority === 'background') : -1;
      if (ahead < 0) this.waiting.push(waiter);
      else this.waiting.splice(ahead, 0, waiter);
    });
  }

  // WHY it looks past the head of the queue: the two priorities have two different caps,
  // so a permit freed from three-in-flight back down to the limit may be one an interactive
  // waiter can take and a background waiter cannot. Handing it to the head regardless would
  // put the limit back over its bound.
  private release(): void {
    this.active -= 1;
    const index = this.waiting.findIndex((w) => this.active < this.capFor(w.priority));
    if (index < 0) return;
    const [next] = this.waiting.splice(index, 1);
    next?.start();
  }

  async run<T>(fn: () => Promise<T>, priority: SessionPriority = 'background'): Promise<T> {
    await this.acquire(priority);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get inFlight(): number {
    return this.active;
  }
}
