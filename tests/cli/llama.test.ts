// FRACTAL: implements F6 | component C2
import { describe, it, expect, afterEach, vi } from 'vitest';
import { LlamaTransport, ensureLlamaServer } from '@/cli/llama';
import { unwrapCliOutput } from '@/cli/run-session';
import { resetConfigCache } from '@/core/config';

const SETTINGS = {
  baseUrl: 'http://127.0.0.1:18080',
  binPath: 'llama-server',
  modelPath: __filename, // any file that exists; the spawn itself is stubbed
};

function drive(transport: LlamaTransport, prompt: string): Promise<{ code: number | null; stdout: string }> {
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

/** The shape llama-server streams back: SSE frames of OpenAI chat deltas. */
function sse(chunks: string[], splitAt?: number): Response {
  const frames = chunks
    .map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`)
    .join('');
  const body = `${frames}data: [DONE]\n\n`;
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (splitAt === undefined) {
          controller.enqueue(encoder.encode(body));
        } else {
          controller.enqueue(encoder.encode(body.slice(0, splitAt)));
          controller.enqueue(encoder.encode(body.slice(splitAt)));
        }
        controller.close();
      },
    }),
    { status: 200 },
  );
}

function healthy(url: string): Response | null {
  return url.endsWith('/health') ? new Response('{"status":"ok"}', { status: 200 }) : null;
}

describe('the local llama.cpp provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetConfigCache();
  });

  it('sends the prompt to a server already running and prints an answer the runner can read', async () => {
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const ok = healthy(String(url));
      if (ok !== null) return ok;
      posts.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return sse(['{"drivingQuestion"', ':"why?"}']);
    });

    const { code, stdout } = await drive(new LlamaTransport(SETTINGS), 'KIND: generate-topic');

    expect(code).toBe(0);
    expect(posts[0].url).toBe('http://127.0.0.1:18080/v1/chat/completions');
    expect(posts[0].body.stream).toBe(true);
    expect(posts[0].body.response_format).toEqual({ type: 'json_object' });
    // WHY low: a reasoning model on its default effort spends minutes deliberating over
    // a prompt whose answer the output contract already pins down, and on local hardware
    // that deliberation is the entire cost of the session.
    expect(posts[0].body.reasoning_effort).toBe('low');
    expect(unwrapCliOutput(JSON.parse(stdout))).toEqual({ ok: true, output: { drivingQuestion: 'why?' } });
  });

  // WHY: SSE frame boundaries do not line up with the socket's chunks, so a `data:` line
  // arrives split in half often enough that not handling it is a truncated lesson.
  it('reassembles an answer split across chunk boundaries', async () => {
    vi.stubGlobal('fetch', async (url: string) => healthy(String(url)) ?? sse(['{"drivingQ', 'uestion":"why?"}'], 40));
    const { code, stdout } = await drive(new LlamaTransport(SETTINGS), 'KIND: generate-topic');
    expect(code).toBe(0);
    expect(unwrapCliOutput(JSON.parse(stdout))).toEqual({ ok: true, output: { drivingQuestion: 'why?' } });
  });

  it('addresses the output contract to the system role and the brief to the user', async () => {
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const ok = healthy(String(url));
      if (ok !== null) return ok;
      posts.push(JSON.parse(String(init.body)));
      return sse(['{"drivingQuestion":"why?"}']);
    });

    await drive(
      new LlamaTransport(SETTINGS),
      'KIND: generate-topic\nTopic subject: x\n\nOUTPUT CONTRACT\nOne JSON object.',
    );

    expect(posts[0].messages).toEqual([
      { role: 'system', content: 'OUTPUT CONTRACT\nOne JSON object.' },
      { role: 'user', content: 'KIND: generate-topic\nTopic subject: x' },
    ]);
  });

  it('reports a refusal with the reason readable', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      healthy(String(url)) ?? new Response('context is full', { status: 400 }),
    );
    const { code, stdout } = await drive(new LlamaTransport(SETTINGS), 'KIND: generate-topic');
    expect(code).toBe(1);
    expect(stdout).toContain('context is full');
  });

  // WHY: an already-answering server is the learner's own, or one left from an earlier
  // session with a model that took minutes to load. Starting a second one would only
  // fail on a port already taken.
  it('uses a server that is already answering instead of starting another', async () => {
    vi.stubGlobal('fetch', async (url: string) => healthy(String(url)) ?? sse(['{}']));
    const outcome = await ensureLlamaServer(SETTINGS);
    expect(outcome).toEqual({ ok: true, started: false });
  });

  // WHY: the Settings screen probes on load and again on save, and a session can dispatch
  // while both are outstanding. Two spawns for one address means a second copy of a
  // multi-gigabyte model loading into the same GPU before the loser of the bind race dies.
  it('starts one server when several callers ask at once', async () => {
    let healthChecks = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (!String(url).endsWith('/health')) return sse(['{}']);
      healthChecks += 1;
      // not serving until something has had a chance to start it
      throw new Error('ECONNREFUSED');
    });
    const missing = { ...SETTINGS, modelPath: 'C:/nope/missing.gguf' };
    const [a, b, c] = await Promise.all([
      ensureLlamaServer(missing),
      ensureLlamaServer(missing),
      ensureLlamaServer(missing),
    ]);
    // all three share one attempt, so one health check was made and one answer returned
    expect(healthChecks).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  // WHY: "no server" is a state the app can fix by itself; "no model file" is not, and
  // saying so is the difference between a repairable setting and a dead end.
  it('says what is missing when no server answers and no model file is set', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    const outcome = await ensureLlamaServer({ ...SETTINGS, modelPath: '' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain('model file');
  });

  it('names the file when the configured model is not on disk', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    const outcome = await ensureLlamaServer({ ...SETTINGS, modelPath: 'C:/nope/missing.gguf' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain('missing.gguf');
  });
});
