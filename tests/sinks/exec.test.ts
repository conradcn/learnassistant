// FRACTAL: covers F6 | type unit
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionRunner, type CliChildHandle, type CliTransport, type SpawnOptions } from '@/cli/run-session';
import { buildPrompt, type ModuleBrief } from '@/cli/prompt';
import { resetConfigCache, saveConfig } from '@/core/config';
import { exampleSessionId, type CliSessionSpec } from '@/shapes';

class RecordingChildHandle implements CliChildHandle {
  readonly pid = 999;
  private exitCbs: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  private stdoutCbs: ((chunk: Buffer) => void)[] = [];

  write(): void {}
  endStdin(): void {
    queueMicrotask(() => {
      for (const cb of this.stdoutCbs) cb(Buffer.from('{}'));
      for (const cb of this.exitCbs) cb(0, null);
    });
  }
  onStdout(cb: (chunk: Buffer) => void): void {
    this.stdoutCbs.push(cb);
  }
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitCbs.push(cb);
  }
  onError(): void {}
  kill(): void {}
}

class RecordingTransport implements CliTransport {
  calls: { bin: string; argv: string[]; opts: SpawnOptions }[] = [];

  spawn(bin: string, argv: string[], opts: SpawnOptions): CliChildHandle {
    this.calls.push({ bin, argv, opts });
    return new RecordingChildHandle();
  }
}

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-sinks-'));
  process.env.LA_DATA_ROOT = dataRoot;
  resetConfigCache();
});

describe('exec sink hardening', () => {
  it('ignores a caller-supplied binary path and uses the configured claudeBin instead', async () => {
    saveConfig({ dataRoot, claudeBin: 'the-real-configured-claude' });
    const transport = new RecordingTransport();
    const runner = new SessionRunner({ transport });
    const moduleDir = path.join(dataRoot, 'topics', 't_9fQ2xK4mZa71bC0d', 'modules', 'm_71bC0d9fQ2xK4mZa');
    mkdirSync(moduleDir, { recursive: true });

    const spec = {
      id: exampleSessionId,
      kind: 'author-module',
      moduleDir,
      prompt: 'hello',
      allowedTools: [],
      timeoutMs: 5000,
      maxTurns: 1,
      claudeBin: '/tmp/attacker-supplied-binary',
    } as CliSessionSpec & { claudeBin: string };

    await runner.run(spec);
    await runner.close();

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].bin).toBe('the-real-configured-claude');
    expect(transport.calls[0].bin).not.toBe('/tmp/attacker-supplied-binary');
  });

  it('never shell-interprets argv — a shell-metacharacter payload executes nothing', async () => {
    saveConfig({ dataRoot, claudeBin: 'claude' });
    const transport = new RecordingTransport();
    const runner = new SessionRunner({ transport });
    const moduleDir = path.join(dataRoot, 'topics', 't_9fQ2xK4mZa71bC0d', 'modules', 'm_71bC0d9fQ2xK4mZa');
    mkdirSync(moduleDir, { recursive: true });
    const canaryFile = path.join(dataRoot, 'pwned.txt');

    const spec: CliSessionSpec = {
      id: exampleSessionId,
      kind: 'author-module',
      moduleDir,
      prompt: 'hello',
      allowedTools: [`; echo pwned > ${canaryFile}`, '$(touch pwned)', '`touch pwned`'],
      timeoutMs: 5000,
      maxTurns: 1,
    };

    await runner.run(spec);
    await runner.close();

    expect(existsSync(canaryFile)).toBe(false);
    const call = transport.calls[0];
    expect(call.argv).toContain(spec.allowedTools.join(','));
  });

  it('an adversarial module title embedded in the prompt cannot inject an extra argv entry', () => {
    const adversarialBrief: ModuleBrief = {
      topicSubject: 'x',
      level: 'intermediate',
      levelDetail: null,
      purpose: 'x',
      drivingQuestion: 'x',
      moduleTitle: '--allowed-tools Bash',
      moduleObjectives: [],
      prerequisiteSummaries: [],
      downstreamSummaries: [],
      priorKnowledge: [],
      targetMinutes: 10,
    };
    const { prompt } = buildPrompt({ kind: 'author-module', brief: adversarialBrief });
    expect(prompt.split('\n')[0]).toBe('KIND: author-module');
    expect(prompt).toContain('--allowed-tools Bash');
    const injectedLineIndex = prompt.split('\n').findIndex((l) => l === '--allowed-tools Bash');
    expect(prompt.split('\n')[injectedLineIndex - 1]).toBe('```');
  });
});
