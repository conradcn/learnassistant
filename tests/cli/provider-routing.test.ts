// FRACTAL: covers F6 | type integration
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { SessionRunner } from '@/cli/run-session';
import { resetConfigCache, saveConfig } from '@/core/config';
import { exampleSessionId, type CliSessionSpec } from '@/shapes';

let dataRoot: string;
let runner: SessionRunner;
let moduleDir: string;

function spec(kind: CliSessionSpec['kind'] = 'author-module'): CliSessionSpec {
  return {
    id: exampleSessionId,
    kind,
    moduleDir,
    prompt: 'KIND: author-module\nwrite it',
    allowedTools: [],
    timeoutMs: 10_000,
    maxTurns: 1,
  };
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-provider-routing-'));
  process.env.LA_DATA_ROOT = dataRoot;
  resetConfigCache();
  moduleDir = path.join(dataRoot, 'topics', 't_9fQ2xK4mZa71bC0d', 'modules', 'm_71bC0d9fQ2xK4mZa');
  mkdirSync(moduleDir, { recursive: true });
  runner = new SessionRunner();
});

afterEach(async () => {
  await runner.close();
  vi.unstubAllGlobals();
  delete process.env.LA_DATA_ROOT;
  rmSync(dataRoot, { recursive: true, force: true });
  resetConfigCache();
});

describe('running a session against the chosen provider', () => {
  it('asks the local server instead of the Claude CLI, and validates its answer the same way', async () => {
    saveConfig({ dataRoot, provider: 'ollama', ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5' } });
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ message: { content: '{"learningGoals":["a"]}' } }), { status: 200 });
    });

    const result = await runner.run(spec(), z.object({ learningGoals: z.array(z.string()) }));

    expect(seen).toEqual(['http://127.0.0.1:11434/api/chat']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toEqual({ learningGoals: ['a'] });
  });

  // WHY this is checked at the runner and not only at the resolver: the split is only
  // real if the model a session actually dials changes with the kind of work it is.
  it('dials the chat model for a learner turn and the planning model for authoring', async () => {
    saveConfig({
      dataRoot,
      provider: 'ollama',
      ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'big' },
      chatModels: { claude: '', ollama: 'small', llama: { baseUrl: 'http://127.0.0.1:18081', modelPath: '' } },
    });
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      asked.push((JSON.parse(init.body) as { model: string }).model);
      return new Response(JSON.stringify({ message: { content: '{"learningGoals":["a"]}' } }), { status: 200 });
    });

    expect((await runner.run(spec('evaluate'))).ok).toBe(true);
    expect((await runner.run(spec('author-module'))).ok).toBe(true);

    expect(asked).toEqual(['small', 'big']);
  });

  it('sends a llama.cpp chat turn to the second server rather than the planning one', async () => {
    saveConfig({
      dataRoot,
      provider: 'llama',
      llama: { baseUrl: 'http://127.0.0.1:18080', binPath: 'llama-server', modelPath: __filename },
      chatModels: { claude: '', ollama: '', llama: { baseUrl: 'http://127.0.0.1:18081', modelPath: __filename } },
    });
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(String(url));
      if (String(url).endsWith('/health')) return new Response('', { status: 200 });
      const frame = JSON.stringify({ choices: [{ delta: { content: '{"learningGoals":["a"]}' } }] });
      return new Response(`data: ${frame}

data: [DONE]

`, { status: 200 });
    });

    expect((await runner.run(spec('evaluate'))).ok).toBe(true);

    expect(seen).toContain('http://127.0.0.1:18081/v1/chat/completions');
    expect(seen.some((u) => u.startsWith('http://127.0.0.1:18080'))).toBe(false);
  });

  // WHY: the runner is built once at boot but the provider is a setting the learner can
  // change mid-session-run. Resolving it per spawn is what makes the switch take effect
  // on the next lesson rather than on the next restart.
  it('picks up a switch back to Claude without rebuilding the runner', async () => {
    saveConfig({ dataRoot, provider: 'ollama' });
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ message: { content: '{"learningGoals":["a"]}' } }), { status: 200 }),
    );
    expect((await runner.run(spec())).ok).toBe(true);

    saveConfig({ dataRoot, provider: 'claude', claudeBin: path.join(dataRoot, 'no-such-binary') });
    const result = await runner.run(spec());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('cli-missing');
  }, 20000);
});
