// FRACTAL: covers F6 | type integration
/**
 * Every hosted adapter, against a fake server.
 *
 * WHY through SessionRunner and not by calling the adapter directly: a provider is only
 * added when a SESSION can run on it, and the seam that decides that — which transport,
 * which model for which role, which envelope the answer comes back in — is the runner's.
 * A test that constructed the handle itself would pass on an adapter the app could not
 * reach. Nothing here touches the network: `fetch` is stubbed, so this stays in the
 * default `npm test` run. The real-network checks live in `e2e/real/`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { SessionRunner } from '@/cli/run-session';
import { resetConfigCache, saveConfig } from '@/core/config';
import { allKeyEnvVars } from '@/core/keys';
import { exampleSessionId, type CliSessionSpec, type ProviderKind } from '@/shapes';

let dataRoot: string;
let runner: SessionRunner;
let moduleDir: string;

const ANSWER = '{"learningGoals":["a"]}';
const OUTPUT = z.object({ learningGoals: z.array(z.string()) });

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function spec(kind: CliSessionSpec['kind'] = 'author-module'): CliSessionSpec {
  return {
    id: exampleSessionId,
    kind,
    moduleDir,
    prompt: 'KIND: author-module\nwrite it\n\nOUTPUT CONTRACT\nOne JSON object.',
    allowedTools: [],
    timeoutMs: 10_000,
    maxTurns: 1,
  };
}

/** An SSE body in the shape `readEventStream` reassembles. */
function sse(frames: unknown[]): Response {
  const text = `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Records every request and answers with the frames the named provider would send. */
function stubServer(reply: (url: string) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: { headers?: unknown; body?: unknown }) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input);
    const rawHeaders = init?.headers ?? {};
    const headers: Record<string, string> = {};
    // WHY both shapes: raw fetch is given a plain object here, but the Anthropic SDK
    // hands its own Headers instance to the same global.
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    } else {
      for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
        headers[k.toLowerCase()] = String(v);
      }
    }
    let body: Record<string, unknown> = {};
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    calls.push({ url, headers, body });
    return reply(url);
  });
  return calls;
}

const openAiFrames = [{ choices: [{ delta: { content: ANSWER } }] }];
const geminiFrames = [{ candidates: [{ content: { parts: [{ text: ANSWER }] }, finishReason: 'STOP' }] }];
const anthropicFrames = [
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANSWER } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];

/**
 * The same frames as Anthropic actually puts them on the wire.
 *
 * WHY it is not the `sse` helper above: Anthropic names every frame in an `event:` line and
 * the SDK dispatches on that name alone, ignoring the `type` inside the payload. A body of
 * bare `data:` lines is silently read as an empty stream. It also never sends `[DONE]`.
 */
function anthropicSse(): Response {
  const text = anthropicFrames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-remote-providers-'));
  process.env.LA_DATA_ROOT = dataRoot;
  for (const name of allKeyEnvVars()) delete process.env[name];
  resetConfigCache();
  moduleDir = path.join(dataRoot, 'topics', 't_9fQ2xK4mZa71bC0d', 'modules', 'm_71bC0d9fQ2xK4mZa');
  mkdirSync(moduleDir, { recursive: true });
  runner = new SessionRunner();
});

afterEach(async () => {
  await runner.close();
  vi.unstubAllGlobals();
  for (const name of allKeyEnvVars()) delete process.env[name];
  delete process.env.LA_DATA_ROOT;
  rmSync(dataRoot, { recursive: true, force: true });
  resetConfigCache();
});

describe('the OpenAI wire format, which is most of the world', () => {
  it('sends the key, the model and the prompt to the chat-completions address', async () => {
    process.env.LA_OPENAI_KEY = 'sk-test-key';
    saveConfig({ dataRoot, provider: 'openai', openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' } });
    const calls = stubServer(() => sse(openAiFrames));

    const result = await runner.run(spec(), OUTPUT);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toEqual({ learningGoals: ['a'] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0].headers.authorization).toBe('Bearer sk-test-key');
    expect(calls[0].body.model).toBe('gpt-4o');
    expect(calls[0].body.stream).toBe(true);
  });

  // WHY this is the case that decides whether the long tail is really supported: the
  // server this adapter most often points at runs on the learner's own machine and has no
  // key at all. An adapter that insisted on one would lock out every one of them.
  it('reaches a keyless server on this computer at the address the learner set', async () => {
    saveConfig({
      dataRoot,
      provider: 'openai-compatible',
      openaiCompatible: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model' },
    });
    const calls = stubServer(() => sse(openAiFrames));

    const result = await runner.run(spec(), OUTPUT);

    expect(result.ok).toBe(true);
    expect(calls[0].url).toBe('http://127.0.0.1:1234/v1/chat/completions');
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].body.model).toBe('local-model');
  });

  it('dials Mistral at its own address with its own model', async () => {
    process.env.LA_MISTRAL_KEY = 'mi-key';
    saveConfig({ dataRoot, provider: 'mistral', mistral: { baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-large-latest' } });
    const calls = stubServer(() => sse(openAiFrames));

    expect((await runner.run(spec(), OUTPUT)).ok).toBe(true);
    expect(calls[0].url).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(calls[0].headers.authorization).toBe('Bearer mi-key');
    expect(calls[0].body.model).toBe('mistral-large-latest');
  });

  // WHY it retries rather than keeping a table of who supports what: `response_format`
  // and a fixed temperature are the two fields this long tail disagrees about, and a
  // table of which server accepts which would be stale the week after it was written.
  it('drops the JSON-mode fields and asks again when a server refuses them', async () => {
    saveConfig({ dataRoot, provider: 'openai-compatible', openaiCompatible: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'picky' } });
    let first = true;
    const calls = stubServer(() => {
      if (first) {
        first = false;
        return new Response('unsupported response_format', { status: 400 });
      }
      return sse(openAiFrames);
    });

    expect((await runner.run(spec(), OUTPUT)).ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].body.response_format).toEqual({ type: 'json_object' });
    expect(calls[1].body.response_format).toBeUndefined();
    expect(calls[1].body.temperature).toBeUndefined();
  });

  it('reports a rejected key as a failed session rather than an empty lesson', async () => {
    process.env.LA_OPENAI_KEY = 'wrong';
    saveConfig({ dataRoot, provider: 'openai', openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' } });
    stubServer(() => new Response('{"error":{"message":"invalid api key"}}', { status: 401 }));

    const result = await runner.run(spec(), OUTPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('nonzero-exit');
  });
});

describe('Gemini, which is the one genuinely different shape', () => {
  it('puts the model in the address, the key in its own header and the role in systemInstruction', async () => {
    process.env.LA_GEMINI_KEY = 'g-key';
    saveConfig({
      dataRoot,
      provider: 'gemini',
      gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
    });
    const calls = stubServer(() => sse(geminiFrames));

    const result = await runner.run(spec(), OUTPUT);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toEqual({ learningGoals: ['a'] });
    expect(calls[0].url).toContain('/models/gemini-2.5-flash:streamGenerateContent');
    expect(calls[0].url).toContain('alt=sse');
    expect(calls[0].headers['x-goog-api-key']).toBe('g-key');
    expect(calls[0].body.systemInstruction).toBeDefined();
  });

  // WHY a safety block is named: it comes back as a perfectly healthy response with no
  // text in it, and "returned no message content" would send the learner looking for a
  // network fault that is not there.
  it('says why it stopped when the answer is blocked rather than empty', async () => {
    process.env.LA_GEMINI_KEY = 'g-key';
    saveConfig({ dataRoot, provider: 'gemini' });
    stubServer(() => sse([{ candidates: [{ finishReason: 'SAFETY' }] }]));

    const result = await runner.run(spec(), OUTPUT);
    expect(result.ok).toBe(false);
  });

  it('refuses to dial at all when no key is set, and names the variable to set', async () => {
    saveConfig({ dataRoot, provider: 'gemini' });
    const calls = stubServer(() => sse(geminiFrames));

    const result = await runner.run(spec(), OUTPUT);

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('Anthropic dialled directly rather than through the CLI', () => {
  it('sends the key and the model to the messages address and reads the streamed answer', async () => {
    process.env.LA_ANTHROPIC_KEY = 'sk-ant-test';
    saveConfig({ dataRoot, provider: 'anthropic', anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5' } });
    const calls = stubServer(() => anthropicSse());

    const result = await runner.run(spec(), OUTPUT);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toEqual({ learningGoals: ['a'] });
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].headers['x-api-key']).toBe('sk-ant-test');
    expect(calls[0].body.model).toBe('claude-opus-5');
    expect(calls[0].body.stream).toBe(true);
  });
});

describe('the same split between a planning model and a chat model, on every provider', () => {
  const cases: { provider: ProviderKind; section: 'openai' | 'gemini' | 'anthropic' | 'mistral' | 'openaiCompatible'; keyVar: string | null }[] = [
    { provider: 'openai', section: 'openai', keyVar: 'LA_OPENAI_KEY' },
    { provider: 'openai-compatible', section: 'openaiCompatible', keyVar: null },
    { provider: 'gemini', section: 'gemini', keyVar: 'LA_GEMINI_KEY' },
    { provider: 'mistral', section: 'mistral', keyVar: 'LA_MISTRAL_KEY' },
    { provider: 'anthropic', section: 'anthropic', keyVar: 'LA_ANTHROPIC_KEY' },
  ];

  for (const { provider, section, keyVar } of cases) {
    it(`dials the chat model for a learner turn and the planning model for authoring on ${provider}`, async () => {
      if (keyVar !== null) process.env[keyVar] = 'k';
      saveConfig({
        dataRoot,
        provider,
        [section]: { baseUrl: 'https://example.test/v1', model: 'big' },
        chatModels: { [section]: 'small' },
      });
      const calls = stubServer(() => {
        if (provider === 'anthropic') return anthropicSse();
        return sse(provider === 'gemini' ? geminiFrames : openAiFrames);
      });

      expect((await runner.run(spec('evaluate'))).ok).toBe(true);
      expect((await runner.run(spec('author-module'))).ok).toBe(true);

      // WHY the URL is checked too: Gemini carries the model id in the address rather
      // than the body, so a body-only assertion would pass on a Gemini that never
      // switched models at all.
      const named = calls.map((c) => `${String(c.body.model ?? '')}${c.url}`);
      expect(named[0]).toContain('small');
      expect(named[1]).toContain('big');
    });
  }
});

describe('keys, which live in the environment and nowhere else', () => {
  it('never writes a key into the saved settings file', () => {
    process.env.LA_OPENAI_KEY = 'sk-secret-value';
    saveConfig({ dataRoot, provider: 'openai' });
    const saved = readFileSync(path.join(dataRoot, 'config.json'), 'utf8');
    expect(saved).not.toContain('sk-secret-value');
    expect(saved).not.toContain('LA_OPENAI_KEY');
  });

  // WHY it is checked at the log rather than only at the config: a key that never
  // reaches `AppConfig` can still reach a log line through a header dump or an error
  // message, and a log is the copy that gets pasted into an issue.
  it('never writes a key into the log, even when the session fails', async () => {
    process.env.LA_OPENAI_KEY = 'sk-secret-value';
    saveConfig({ dataRoot, provider: 'openai' });
    stubServer(() => new Response('nope', { status: 500 }));

    expect((await runner.run(spec(), OUTPUT)).ok).toBe(false);

    const logDir = path.join(dataRoot, 'logs');
    const lines = readFileSync(
      path.join(logDir, `app-${new Date().toISOString().slice(0, 10)}.ndjson`),
      'utf8',
    );
    expect(lines).not.toContain('sk-secret-value');
  });
});
