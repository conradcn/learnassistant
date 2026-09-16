// FRACTAL: implements F6 | component C2
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OllamaTransport, checkOllamaAvailable } from '@/cli/ollama';
import { unwrapCliOutput } from '@/cli/run-session';
import { resetConfigCache } from '@/core/config';

const SETTINGS = { baseUrl: 'http://127.0.0.1:11434', model: 'llama3.1' };

function drive(transport: OllamaTransport, prompt: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const handle = transport.spawn('claude', [], { cwd: '.', env: {} });
    let stdout = '';
    handle.onStdout((chunk) => {
      stdout += chunk.toString('utf8');
    });
    handle.onExit((code) => resolve({ code, stdout }));
    handle.write(prompt);
    handle.endStdin();
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('the local Ollama provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetConfigCache();
  });

  it('sends the prompt to the local server and prints an answer the session runner can read', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return jsonResponse({ message: { content: '{"learningGoals":["a"]}' } });
    });

    const { code, stdout } = await drive(new OllamaTransport(SETTINGS), 'KIND: author-module\nwrite it');

    expect(code).toBe(0);
    expect(calls[0].url).toBe('http://127.0.0.1:11434/api/chat');
    expect(calls[0].body.model).toBe('llama3.1');
    // WHY streaming: a non-streamed Ollama reply sends no headers until generation
    // ends, and Node's fetch abandons a header-less response after five minutes.
    expect(calls[0].body.stream).toBe(true);
    // WHY: the output contracts ask for one JSON object; JSON mode is what makes a
    // small local model keep that promise instead of prefacing it with an apology.
    expect(calls[0].body.format).toBe('json');
    // WHY low: a reasoning model on its default effort spends minutes deliberating over
    // a prompt whose answer the output contract already pins down, and on local hardware
    // that deliberation is the entire cost of the session.
    expect(calls[0].body.think).toBe('low');
    expect(calls[0].body.messages).toEqual([{ role: 'user', content: 'KIND: author-module\nwrite it' }]);
    expect(unwrapCliOutput(JSON.parse(stdout))).toEqual({ ok: true, output: { learningGoals: ['a'] } });
  });

  // WHY: with stream:true the answer arrives as many NDJSON frames, and the frame
  // boundaries do not line up with the socket's chunks — a line can be split in half.
  it('reassembles an answer that arrives in pieces across chunk boundaries', async () => {
    const frames =
      [
        JSON.stringify({ message: { content: '{"driving' } }),
        JSON.stringify({ message: { content: 'Question":"why?"}' } }),
        JSON.stringify({ done: true }),
      ].join('\n') + '\n';
    vi.stubGlobal('fetch', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // split mid-line, not on a newline
          controller.enqueue(encoder.encode(frames.slice(0, 30)));
          controller.enqueue(encoder.encode(frames.slice(30)));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    });
    const { code, stdout } = await drive(new OllamaTransport(SETTINGS), 'KIND: generate-topic');
    expect(code).toBe(0);
    expect(unwrapCliOutput(JSON.parse(stdout))).toEqual({ ok: true, output: { drivingQuestion: 'why?' } });
  });

  // WHY: a small local model follows an output contract addressed to it as a system
  // instruction and ignores the same words buried at the end of a long user message.
  it('addresses the output contract to the system role and the brief to the user', async () => {
    const calls: { body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      calls.push({ body: JSON.parse(String(init.body)) });
      return jsonResponse({ message: { content: '{"drivingQuestion":"why?"}' } });
    });

    const prompt = 'KIND: generate-topic\nTopic subject: x\n\nOUTPUT CONTRACT\nOne JSON object.';
    await drive(new OllamaTransport(SETTINGS), prompt);

    expect(calls[0].body.messages).toEqual([
      { role: 'system', content: 'OUTPUT CONTRACT\nOne JSON object.' },
      { role: 'user', content: 'KIND: generate-topic\nTopic subject: x' },
    ]);
  });

  // WHY: `think` is rejected outright by a model with no reasoning mode, and choosing
  // such a model must not look like a broken install.
  it('retries without the effort setting when the model has no reasoning mode', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      if ('think' in body) return new Response('"llama3.1" does not support thinking', { status: 400 });
      return jsonResponse({ message: { content: '{"drivingQuestion":"why?"}' } });
    });

    const { code, stdout } = await drive(new OllamaTransport(SETTINGS), 'KIND: generate-topic');

    expect(code).toBe(0);
    expect(bodies.length).toBe(2);
    expect('think' in bodies[1]).toBe(false);
    expect(unwrapCliOutput(JSON.parse(stdout))).toEqual({ ok: true, output: { drivingQuestion: 'why?' } });
  });

  // WHY: a 400 that is not about thinking is a real failure, and retrying it would hide
  // the reason behind a second identical refusal.
  it('reports a refusal that is not about thinking instead of retrying', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return new Response('model "llama3.1" not found', { status: 400 });
    });

    const { code, stdout } = await drive(new OllamaTransport(SETTINGS), 'KIND: generate-topic');

    expect(code).toBe(1);
    expect(calls).toBe(1);
    expect(stdout).toContain('not found');
  });

  it('recovers an answer the model wrapped in a code fence', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse({ message: { content: 'Sure:\n```json\n{"drivingQuestion":"why?"}\n```' } }),
    );
    const { stdout } = await drive(new OllamaTransport(SETTINGS), 'KIND: generate-topic');
    expect(unwrapCliOutput(JSON.parse(stdout))).toEqual({ ok: true, output: { drivingQuestion: 'why?' } });
  });

  it('fails the session, with the reason readable, when the server refuses', async () => {
    vi.stubGlobal('fetch', async () => new Response('model not found', { status: 404 }));
    const { code, stdout } = await drive(new OllamaTransport(SETTINGS), 'KIND: author-module');
    expect(code).toBe(1);
    expect(stdout).toContain('model not found');
  });

  it('fails the session when no server is listening', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
    });
    const { code, stdout } = await drive(new OllamaTransport(SETTINGS), 'KIND: author-module');
    expect(code).toBe(1);
    expect(stdout).toContain('ECONNREFUSED');
  });

  // WHY: cancelling a session must actually stop the work, not just stop listening —
  // a local model left generating holds the machine's GPU for minutes afterwards.
  it('abandons the request when the session is cancelled', async () => {
    let aborted = false;
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      }),
    );
    const transport = new OllamaTransport(SETTINGS);
    const handle = transport.spawn('claude', [], { cwd: '.', env: {} });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => handle.onExit((_c, signal) => resolve(signal)));
    handle.write('KIND: author-module');
    handle.endStdin();
    handle.kill('SIGTERM');
    expect(await exited).toBe('SIGTERM');
    expect(aborted).toBe(true);
  });
});

describe('checking the local provider is usable', () => {
  beforeEach(() => {
    resetConfigCache();
    vi.stubEnv('LA_PROVIDER', 'ollama');
    vi.stubEnv('LA_OLLAMA_URL', 'http://127.0.0.1:11434');
    vi.stubEnv('LA_OLLAMA_MODEL', 'llama3.1');
  });

  it('says it is ready when the server has the model', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ models: [{ name: 'llama3.1:latest' }] }));
    const result = await checkOllamaAvailable();
    expect(result.ok).toBe(true);
  });

  // WHY: a reachable server missing the configured model fails every session at dispatch
  // time instead — the whole point of the probe is that the learner hears it here.
  it('names the pull command when the model is not installed', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ models: [{ name: 'mistral:latest' }] }));
    const result = await checkOllamaAvailable();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('ollama pull llama3.1');
  });

  // WHY: comparing only the part before the colon reported a tag the server does not
  // have as installed — Settings said Ready and /api/chat then answered 404 once per
  // session, which is the failure the probe exists to catch.
  it('does not accept a different tag of the same model as the one configured', async () => {
    vi.stubEnv('LA_OLLAMA_MODEL', 'qwen3.8:4090-27b');
    resetConfigCache();
    vi.stubGlobal('fetch', async () => jsonResponse({ models: [{ name: 'qwen3.8:latest' }] }));
    const result = await checkOllamaAvailable();
    expect(result.ok).toBe(false);
  });

  it('says how to start the server when nothing answers', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await checkOllamaAvailable();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('ollama serve');
  });
});
