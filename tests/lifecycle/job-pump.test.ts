// FRACTAL: covers F1 | type unit
import { afterEach, describe, expect, it } from 'vitest';
import { pumpJobs, resetServices, startPrepSweep } from '@/api/services';
import type { Services } from '@/api/services';

afterEach(() => {
  resetServices();
});

function servicesWithDrain(drain: () => Promise<unknown>): Services {
  return { orchestrator: { drain } } as unknown as Services;
}

describe('the background job pump', () => {
  it('drains again for a job enqueued while a drain was already finishing', async () => {
    let running: (() => void) | null = null;
    let drains = 0;
    const svc = servicesWithDrain(() => {
      drains += 1;
      return new Promise<void>((resolve) => {
        running = resolve;
      });
    });

    pumpJobs(svc);
    expect(drains).toBe(1);

    // the window that lost the wakeup: a request enqueues while the first drain
    // has not yet cleared its own guard.
    pumpJobs(svc);
    expect(drains).toBe(1);

    const finishFirst = running as unknown as () => void;
    finishFirst();
    await new Promise((r) => setImmediate(r));

    expect(drains).toBe(2);
    (running as unknown as () => void)();
    await new Promise((r) => setImmediate(r));
  });

  it('stops looping once no further work was requested', async () => {
    let drains = 0;
    const svc = servicesWithDrain(() => {
      drains += 1;
      return Promise.resolve();
    });
    pumpJobs(svc);
    await new Promise((r) => setImmediate(r));
    expect(drains).toBe(1);
  });

  it('does not leave the pump wedged when a drain throws', async () => {
    let drains = 0;
    const svc = servicesWithDrain(() => {
      drains += 1;
      return Promise.reject(new Error('drain blew up'));
    });
    pumpJobs(svc);
    await new Promise((r) => setImmediate(r));
    pumpJobs(svc);
    await new Promise((r) => setImmediate(r));
    expect(drains).toBe(2);
  });
});

/**
 * WHY: the pump only ever ran on the edge of a request that enqueued something, so any
 * lost edge — a drain that threw with the queue half-full, a boot requeue in a process
 * nobody POSTs to again — left rows in `queued` with nobody coming back for them, and the
 * learner watched "Planning your lessons…" until an unrelated click happened to pump.
 */
describe('the queue heartbeat on the prep sweep', () => {
  function servicesWithQueue(queuedCount: () => number, drain: () => Promise<unknown>): Services {
    return {
      orchestrator: { drain },
      dataRoot: '',
      store: { topics: { list: () => [] }, jobs: { queuedCount } },
    } as unknown as Services;
  }

  it('drains work left in the queue when no request came back for it', async () => {
    let drains = 0;
    const svc = servicesWithQueue(
      () => 1,
      () => {
        drains += 1;
        return Promise.resolve();
      },
    );
    startPrepSweep(svc);
    await new Promise((r) => setImmediate(r));
    expect(drains).toBe(1);
  });

  it('leaves an idle app idle when the queue is empty', async () => {
    let drains = 0;
    const svc = servicesWithQueue(
      () => 0,
      () => {
        drains += 1;
        return Promise.resolve();
      },
    );
    startPrepSweep(svc);
    await new Promise((r) => setImmediate(r));
    expect(drains).toBe(0);
  });

  it('still drains when the sweep itself threw', async () => {
    let drains = 0;
    const svc = servicesWithQueue(
      () => 2,
      () => {
        drains += 1;
        return Promise.resolve();
      },
    );
    (svc.store.topics as unknown as { list: () => never }).list = () => {
      throw new Error('one subject is unreadable');
    };
    startPrepSweep(svc);
    await new Promise((r) => setImmediate(r));
    expect(drains).toBe(1);
  });
});
