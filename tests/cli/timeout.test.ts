// FRACTAL: covers F6 | type lifecycle
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn as nodeSpawn, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionRunner, type CliChildHandle, type CliTransport, type SpawnOptions } from '@/cli/run-session';
import { resetConfigCache, saveConfig } from '@/core/config';
import { exampleSessionId, type CliSessionSpec } from '@/shapes';

class HangingChildHandle implements CliChildHandle {
  readonly pid: number | undefined;
  private readonly child: ReturnType<typeof nodeSpawn>;

  constructor(opts: SpawnOptions) {
    this.child = nodeSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pid = this.child.pid;
  }

  write(): void {}
  endStdin(): void {
    this.child.stdin?.end();
  }
  onStdout(cb: (chunk: Buffer) => void): void {
    this.child.stdout?.on('data', cb);
  }
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.child.on('exit', (code, signal) => cb(code, signal));
  }
  onError(cb: (err: Error) => void): void {
    this.child.on('error', cb);
  }
  kill(signal: NodeJS.Signals): void {
    if (this.pid === undefined) return;
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /pid ${this.pid} /t /f`, { stdio: 'ignore' });
      } catch {
        // already gone
      }
      return;
    }
    try {
      process.kill(-this.pid, signal);
    } catch {
      // already gone
    }
  }
}

class HangingTransport implements CliTransport {
  lastHandle: HangingChildHandle | undefined;

  spawn(_bin: string, _argv: string[], opts: SpawnOptions): CliChildHandle {
    const handle = new HangingChildHandle(opts);
    this.lastHandle = handle;
    return handle;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let dataRoot: string;
let runner: SessionRunner;
let transport: HangingTransport;

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-timeout-'));
  process.env.LA_DATA_ROOT = dataRoot;
  resetConfigCache();
  saveConfig({ dataRoot, claudeBin: 'unused-in-this-test' });
  transport = new HangingTransport();
  runner = new SessionRunner({ transport });
});

afterEach(async () => {
  await runner.close();
});

describe('SessionRunner timeout', () => {
  it('kills a child that never returns within the declared window and clears the in-flight flag', async () => {
    const moduleDir = path.join(dataRoot, 'topics', 't_9fQ2xK4mZa71bC0d', 'modules', 'm_71bC0d9fQ2xK4mZa');
    mkdirSync(moduleDir, { recursive: true });

    const spec: CliSessionSpec = {
      id: exampleSessionId,
      kind: 'author-module',
      moduleDir,
      prompt: 'hello',
      allowedTools: [],
      timeoutMs: 500,
      maxTurns: 1,
    };

    const started = Date.now();
    const result = await runner.run(spec);
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('timeout');
    }
    expect(elapsed).toBeLessThan(10000);

    const pid = transport.lastHandle?.pid;
    expect(pid).toBeDefined();
    await new Promise((r) => setTimeout(r, 300));
    expect(isProcessAlive(pid as number)).toBe(false);
  }, 20000);

  // WHY: the per-request budgets are sized for a hosted model. A local model spends
  // longer than an evaluation turn's 120s on its first token, so with Ollama selected
  // those budgets must act as floors — otherwise every local session is killed while
  // the model is still working, which is the "the evaluator went silent" report.
  it('does not enforce a hosted-sized budget against a local model', async () => {
    saveConfig({ dataRoot, provider: 'ollama' });
    const moduleDir = path.join(dataRoot, 'topics', 't_9fQ2xK4mZa71bC0d', 'modules', 'm_71bC0d9fQ2xK4mZa');
    mkdirSync(moduleDir, { recursive: true });

    const spec: CliSessionSpec = {
      id: exampleSessionId,
      kind: 'author-module',
      moduleDir,
      prompt: 'hello',
      allowedTools: [],
      timeoutMs: 300,
      maxTurns: 1,
    };

    const run = runner.run(spec);
    const settledEarly = await Promise.race([
      run.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 1500)),
    ]);
    expect(settledEarly).toBe(false);

    runner.cancel(spec.id);
    await run;
  }, 20000);
});

// WHY this exists: killTree() arms the SIGKILL escalation, but every caller settles the
// session in the same tick, and finish() used to clear that timer on its way out. Against
// a child that ignores SIGTERM — the wedged case the stall budget is for — the escalation
// never fired, and the orphan held a provider session that cancel() could no longer reach.
class DeafChildHandle implements CliChildHandle {
  readonly pid: number | undefined;
  private readonly child: ReturnType<typeof nodeSpawn>;

  constructor(opts: SpawnOptions) {
    this.child = nodeSpawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      {
        cwd: opts.cwd,
        env: opts.env as NodeJS.ProcessEnv,
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.pid = this.child.pid;
  }

  write(): void {}
  endStdin(): void {
    this.child.stdin?.end();
  }
  onStdout(cb: (chunk: Buffer) => void): void {
    this.child.stdout?.on('data', cb);
  }
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.child.on('exit', (code, signal) => cb(code, signal));
  }
  onError(cb: (err: Error) => void): void {
    this.child.on('error', cb);
  }
  // Deliberately signals the process itself rather than force-killing the group: the point
  // is that SIGTERM is ignored and only the SIGKILL escalation can end this child.
  kill(signal: NodeJS.Signals): void {
    if (this.pid === undefined) return;
    try {
      process.kill(this.pid, signal);
    } catch {
      // already gone
    }
  }
}

class DeafTransport implements CliTransport {
  lastHandle: DeafChildHandle | undefined;

  spawn(_bin: string, _argv: string[], opts: SpawnOptions): CliChildHandle {
    const handle = new DeafChildHandle(opts);
    this.lastHandle = handle;
    return handle;
  }
}

// SIGTERM cannot be ignored on Windows, so there is no "deaf child" to escalate against.
describe.skipIf(process.platform === 'win32')('SessionRunner SIGKILL escalation', () => {
  it('kills a stalled child that ignores SIGTERM', async () => {
    const deaf = new DeafTransport();
    const stallRunner = new SessionRunner({ transport: deaf, stallMs: 300 });
    const moduleDir = path.join(dataRoot, 'topics', 't_9fQ2xK4mZa71bC0d', 'modules', 'm_71bC0d9fQ2xK4mZa');
    mkdirSync(moduleDir, { recursive: true });

    const spec: CliSessionSpec = {
      id: exampleSessionId,
      kind: 'author-module',
      moduleDir,
      prompt: 'hello',
      allowedTools: [],
      // Long enough that the stall budget, not the hard timeout, is what fires.
      timeoutMs: 60_000,
      maxTurns: 1,
    };

    const result = await stallRunner.run(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('timeout');

    const pid = deaf.lastHandle?.pid;
    expect(pid).toBeDefined();
    // Still alive right after the session settled: SIGTERM was ignored.
    expect(isProcessAlive(pid as number)).toBe(true);

    // KILL_GRACE_MS is 5s; wait that plus a margin for the escalation to land.
    const deadline = Date.now() + 8_000;
    while (isProcessAlive(pid as number) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(isProcessAlive(pid as number)).toBe(false);

    await stallRunner.close();
  }, 30_000);
});

// The real-process test above cannot run on Windows, where SIGTERM is not ignorable.
// This one proves the same escalation on every platform without a real child: the handle
// simply records the signals it is sent and never exits.
class SignalRecordingHandle implements CliChildHandle {
  readonly pid = 1;
  readonly signals: NodeJS.Signals[] = [];

  write(): void {}
  endStdin(): void {}
  onStdout(): void {}
  onExit(): void {}
  onError(): void {}
  kill(signal: NodeJS.Signals): void {
    this.signals.push(signal);
  }
}

describe('SessionRunner SIGKILL escalation (transport-level)', () => {
  it('escalates to SIGKILL after the grace period even though the session already settled', async () => {
    const handle = new SignalRecordingHandle();
    const stallRunner = new SessionRunner({
      transport: { spawn: () => handle },
      stallMs: 300,
    });
    const moduleDir = path.join(dataRoot, 'topics', 't_9fQ2xK4mZa71bC0d', 'modules', 'm_71bC0d9fQ2xK4mZa');
    mkdirSync(moduleDir, { recursive: true });

    const result = await stallRunner.run({
      id: exampleSessionId,
      kind: 'author-module',
      moduleDir,
      prompt: 'hello',
      allowedTools: [],
      timeoutMs: 60_000,
      maxTurns: 1,
    });
    expect(result.ok).toBe(false);
    expect(handle.signals).toEqual(['SIGTERM']);

    const deadline = Date.now() + 8_000;
    while (!handle.signals.includes('SIGKILL') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(handle.signals).toContain('SIGKILL');

    await stallRunner.close();
  }, 30_000);
});
