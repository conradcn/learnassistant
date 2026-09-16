// FRACTAL: covers F6 | type lifecycle | path cli-exits-nonzero-after-answering
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionRunner, type CliChildHandle, type CliTransport } from '@/cli/run-session';
import { resetConfigCache, saveConfig } from '@/core/config';
import { exampleSessionId, type CliSessionSpec } from '@/shapes';

/** A child that emits a fixed stdout and then exits with a fixed code. */
class ScriptedHandle implements CliChildHandle {
  readonly pid = undefined;
  private out: ((chunk: Buffer) => void) | undefined;
  private exit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;

  constructor(
    private readonly stdout: string,
    private readonly code: number,
  ) {}

  write(): void {}
  endStdin(): void {
    setTimeout(() => {
      this.out?.(Buffer.from(this.stdout, 'utf8'));
      this.exit?.(this.code, null);
    }, 0);
  }
  onStdout(cb: (chunk: Buffer) => void): void {
    this.out = cb;
  }
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exit = cb;
  }
  onError(): void {}
  kill(): void {}
}

class ScriptedTransport implements CliTransport {
  constructor(
    private readonly stdout: string,
    private readonly code: number,
  ) {}
  spawn(): CliChildHandle {
    return new ScriptedHandle(this.stdout, this.code);
  }
}

const outputSchema = z.object({ title: z.string(), body: z.string() }).strict();

function envelope(result: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'result', result: JSON.stringify(result), ...extra });
}

let dataRoot: string;
let runner: SessionRunner;

function specIn(root: string): CliSessionSpec {
  const moduleDir = path.join(root, 'topics', 't_9fQ2xK4mZa71bC0d', 'modules', 'm_71bC0d9fQ2xK4mZa');
  mkdirSync(moduleDir, { recursive: true });
  return {
    id: exampleSessionId,
    kind: 'author-module',
    moduleDir,
    prompt: 'hello',
    allowedTools: [],
    timeoutMs: 5000,
    maxTurns: 1,
  };
}

async function runWith(stdout: string, code: number): Promise<Awaited<ReturnType<SessionRunner['run']>>> {
  runner = new SessionRunner({ transport: new ScriptedTransport(stdout, code) });
  return runner.run(specIn(dataRoot), outputSchema);
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-nonzero-'));
  process.env.LA_DATA_ROOT = dataRoot;
  resetConfigCache();
  saveConfig({ dataRoot, claudeBin: 'unused-in-this-test' });
});

afterEach(async () => {
  await runner.close();
  delete process.env.LA_DATA_ROOT;
  resetConfigCache();
});

/**
 * WHY: on a real 14-session run the CLI twice exited non-zero after streaming a finished
 * answer. The exit code was read first and 16KB of complete lesson was discarded unread,
 * costing the learner a session they had consented to and paid for.
 */
describe('a CLI that exits non-zero after answering', () => {
  const good = { title: 'Norms', body: 'A norm measures length.' };

  it('keeps an answer that is complete and valid, however the process exited', async () => {
    const result = await runWith(envelope(good), 1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toEqual(good);
  });

  it('still fails when the non-zero exit came with nothing usable', async () => {
    const result = await runWith('', 1);
    expect(result.ok).toBe(false);
    // The learner is told the process failed, not that its (absent) output was misshapen.
    if (!result.ok) expect(result.message).toMatch(/exited with code 1/);
  });

  it('refuses a half-written answer rather than reporting the exit code as success', async () => {
    const result = await runWith(envelope({ title: 'Norms' }), 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/exited with code 1/);
  });

  it('never overrides the CLI when the CLI itself calls the session failed', async () => {
    const result = await runWith(envelope(good, { is_error: true }), 1);
    expect(result.ok).toBe(false);
  });

  // A clean exit must keep reporting what was actually wrong with the output.
  it('still names a shape mismatch on a clean exit', async () => {
    const result = await runWith(envelope({ title: 'Norms' }), 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/did not match the expected shape/);
  });
});
