// FRACTAL: covers F6 | type unit
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionRunner, type CliChildHandle, type CliTransport, type SpawnOptions } from '@/cli/run-session';
import { Semaphore } from '@/cli/semaphore';
import { resetConfigCache, saveConfig } from '@/core/config';
import { sessionIdSchema, type CliSessionSpec } from '@/shapes';

/** Answers only when the test says so, so overlap is observable rather than raced for. */
class HeldTransport implements CliTransport {
  live = 0;
  peak = 0;
  private readonly finishers: (() => void)[] = [];

  spawn(_bin: string, _argv: string[], _opts: SpawnOptions): CliChildHandle {
    this.live += 1;
    this.peak = Math.max(this.peak, this.live);
    const outs: ((b: Buffer) => void)[] = [];
    const exits: ((c: number | null, s: NodeJS.Signals | null) => void)[] = [];
    const finish = (): void => {
      for (const o of outs) o(Buffer.from('{"ok":true}'));
      for (const e of exits) e(0, null);
    };
    this.finishers.push(() => {
      this.live -= 1;
      finish();
    });
    return {
      pid: 4242,
      write(): void {},
      endStdin(): void {},
      onStdout(cb): void {
        outs.push(cb);
      },
      onExit(cb): void {
        exits.push(cb);
      },
      onError(): void {},
      kill(): void {},
    };
  }

  /** Lets every session spawned so far come back. */
  releaseAll(): void {
    const pending = this.finishers.splice(0, this.finishers.length);
    for (const done of pending) done();
  }

  get spawned(): number {
    return this.live + 0;
  }
}

let dataRoot: string;
let runner: SessionRunner;
let transport: HeldTransport;

// WHY a directory each: the runner also serialises sessions that share a module
// directory, and that is a different rule from the one under test here.
function specFor(n: number, kind: CliSessionSpec['kind'] = 'author-module'): CliSessionSpec {
  const moduleDir = path.join(
    dataRoot,
    'topics',
    't_9fQ2xK4mZa71bC0d',
    'modules',
    `m_71bC0d9fQ2xK4mZ${n}`,
  );
  mkdirSync(moduleDir, { recursive: true });
  return {
    id: sessionIdSchema.parse(`s_${String(n).padStart(16, '0')}`),
    kind,
    moduleDir,
    prompt: 'hello',
    allowedTools: [],
    timeoutMs: 30_000,
    maxTurns: 1,
  };
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-conc-'));
  process.env.LA_DATA_ROOT = dataRoot;
  resetConfigCache();
  saveConfig({ dataRoot, claudeBin: 'unused-in-this-test', sessionConcurrency: 2 });
  transport = new HeldTransport();
  runner = new SessionRunner({ transport });
});

afterEach(async () => {
  await runner.close();
  delete process.env.LA_DATA_ROOT;
  resetConfigCache();
  rmSync(dataRoot, { recursive: true, force: true });
});

/**
 * WHY this limit is kept when the rest of the dispatch gating went: it is not a permission
 * question. Every session in this app — a writing fan-out, an evaluation turn, a review
 * question — is load on one provider, and the runner is the only place that sees all of
 * them. It is a queue and never a refusal: work over the limit waits and then runs.
 */
describe('the session runner', () => {
  it('never has more sessions open than the configured limit', async () => {
    const runs = [1, 2, 3, 4, 5].map((n) => runner.run(specFor(n)));
    await new Promise((r) => setTimeout(r, 20));
    expect(transport.live).toBe(2);

    transport.releaseAll();
    await new Promise((r) => setTimeout(r, 20));
    transport.releaseAll();
    await new Promise((r) => setTimeout(r, 20));
    transport.releaseAll();

    const results = await Promise.all(runs);
    expect(results).toHaveLength(5);
    expect(transport.peak).toBeLessThanOrEqual(2);
  }, 20000);

  /**
   * WHY (F4 / learner latency): a `generate-topic` fan-out queues every unwritten module at
   * once, and each of those sessions runs for minutes. A learner's evaluation turn used to
   * join the tail of that queue, so the answer they had already sent sat unanswered for the
   * length of the whole batch with nothing on screen and nothing to press. The turn a person
   * is waiting on does not queue behind the writing done ahead of them.
   */
  it('starts a learner turn ahead of a backlog of authoring sessions', async () => {
    const authoring = [1, 2, 3, 4, 5].map((n) => runner.run(specFor(n)));
    await new Promise((r) => setTimeout(r, 20));
    expect(transport.live).toBe(2);

    const turn = runner.run(specFor(6, 'evaluate'));
    await new Promise((r) => setTimeout(r, 20));
    // It ran without waiting for a permit to come back, and took one permit and not more.
    expect(transport.live).toBe(3);

    transport.releaseAll();
    await expect(turn).resolves.toMatchObject({ ok: true });

    for (let i = 0; i < 4; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      transport.releaseAll();
    }
    await Promise.all(authoring);
    expect(transport.peak).toBe(3);
  }, 20000);
});

describe('the permit queue underneath it', () => {
  it('runs one section at a time at a limit of one, in the order asked', async () => {
    const slots = new Semaphore(1);
    const order: string[] = [];
    let inside = 0;
    let maxInside = 0;

    const section = async (name: string): Promise<void> => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      await new Promise((r) => setTimeout(r, 1));
      order.push(name);
      inside -= 1;
    };

    await Promise.all([slots.run(() => section('a')), slots.run(() => section('b')), slots.run(() => section('c'))]);

    expect(maxInside).toBe(1);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('lets an interactive section past a full queue, one permit above the limit', async () => {
    const slots = new Semaphore(2);
    const order: string[] = [];
    let inside = 0;
    let maxInside = 0;
    const held: (() => void)[] = [];

    const section = (name: string): Promise<void> => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      return new Promise<void>((resolve) => held.push(resolve)).then(() => {
        order.push(name);
        inside -= 1;
      });
    };
    const release = (): Promise<void> => {
      held.splice(0, held.length).forEach((done) => done());
      return new Promise((r) => setTimeout(r, 1));
    };

    const background = ['a', 'b', 'c', 'd'].map((n) => slots.run(() => section(n)));
    await new Promise((r) => setTimeout(r, 1));
    expect(inside).toBe(2);

    const interactive = slots.run(() => section('turn'), 'interactive');
    await new Promise((r) => setTimeout(r, 1));
    expect(inside).toBe(3);

    await release();
    await interactive;
    // The headroom is one: the backlog never widens past the configured limit because of it.
    expect(maxInside).toBe(3);

    await release();
    await release();
    await Promise.all(background);
    expect(order).toEqual(['a', 'b', 'turn', 'c', 'd']);
  });

  // WHY: two interactive turns must not each claim the headroom — that is how a "small"
  // allowance turns into an unbounded one when several learners are mid-conversation.
  it('holds interactive work to the same one permit of headroom no matter how much arrives', async () => {
    const slots = new Semaphore(2);
    let inside = 0;
    let maxInside = 0;
    const held: (() => void)[] = [];
    const section = (): Promise<void> => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      return new Promise<void>((resolve) => held.push(resolve)).then(() => {
        inside -= 1;
      });
    };

    const runs = [1, 2, 3, 4, 5].map(() => slots.run(() => section(), 'interactive'));
    await new Promise((r) => setTimeout(r, 1));
    expect(inside).toBe(3);

    for (let i = 0; i < 5; i += 1) {
      held.splice(0, held.length).forEach((done) => done());
      await new Promise((r) => setTimeout(r, 1));
    }
    await Promise.all(runs);
    expect(maxInside).toBe(3);
  });

  // WHY: a throw that kept its permit would wedge every later session behind a failure
  // that is already over.
  it('gives the permit back when a section throws', async () => {
    const slots = new Semaphore(1);
    await expect(
      slots.run(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(slots.run(() => Promise.resolve('still here'))).resolves.toBe('still here');
  });
});
