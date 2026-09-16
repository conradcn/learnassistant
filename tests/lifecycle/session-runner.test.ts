// FRACTAL: covers F6 | type integration lifecycle
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionRunner } from '@/cli/run-session';
import { FakeTransport } from '@/cli/transport.fake';
import { resetConfigCache, saveConfig } from '@/core/config';
import { exampleSessionId, sessionIdSchema, type CliSessionSpec } from '@/shapes';

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-lifecycle-'));
  process.env.LA_DATA_ROOT = dataRoot;
  resetConfigCache();
  saveConfig({ dataRoot, claudeBin: 'claude' });
});

function makeModuleDir(): string {
  const moduleDir = path.join(dataRoot, 'topics', 't_9fQ2xK4mZa71bC0d', 'modules', 'm_71bC0d9fQ2xK4mZa');
  mkdirSync(moduleDir, { recursive: true });
  return moduleDir;
}

describe('SessionRunner lifecycle', () => {
  it('cancelling mid-flight kills the process and releases the per-module mutex', async () => {
    const transport = new FakeTransport();
    transport.queue({ neverExit: true });
    const runner = new SessionRunner({ transport });
    const moduleDir = makeModuleDir();

    const spec: CliSessionSpec = {
      id: exampleSessionId,
      kind: 'author-module',
      moduleDir,
      prompt: 'hello',
      allowedTools: [],
      timeoutMs: 60_000,
      maxTurns: 1,
    };

    const runPromise = runner.run(spec);
    await new Promise((r) => setTimeout(r, 20));
    runner.cancel(spec.id);
    const result = await runPromise;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('cancelled');

    transport.queue({ stdoutChunks: ['{}'], exitCode: 0 });
    const secondSpec: CliSessionSpec = { ...spec, id: sessionIdSchema.parse('s_0d9fQ2xK4mZa71bC') };
    const secondResult = await runner.run(secondSpec);
    expect(secondResult.ok).toBe(true);

    await runner.close();
  });

  it('close() cancels every child and leaves zero in-flight', async () => {
    const transport = new FakeTransport();
    transport.queue({ neverExit: true });
    const runner = new SessionRunner({ transport });
    const moduleDir = makeModuleDir();

    const spec: CliSessionSpec = {
      id: exampleSessionId,
      kind: 'author-module',
      moduleDir,
      prompt: 'hello',
      allowedTools: [],
      timeoutMs: 60_000,
      maxTurns: 1,
    };

    const runPromise = runner.run(spec);
    await new Promise((r) => setTimeout(r, 20));
    await runner.close();
    const result = await runPromise;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('cancelled');

    const secondSpec: CliSessionSpec = { ...spec, id: sessionIdSchema.parse('s_0d9fQ2xK4mZa71bC') };
    await expect(runner.run(secondSpec)).resolves.toMatchObject({ ok: false, code: 'cancelled' });
  });
});
