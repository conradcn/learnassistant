// FRACTAL: covers F2 | type unit | path the-sse-parser-behind-the-progress-bar
/**
 * `subscribeProgress` reads the generation stream off a plain fetch and frames it by hand,
 * because `EventSource` cannot carry the per-launch token header. Everything that framing
 * gets wrong shows up to the learner the same way — a progress bar frozen mid-generation
 * while the server is fine — so the byte-level cases are pinned here: an event cut in half
 * mid-field by a chunk boundary, several events arriving at once, a trailing fragment that
 * is not an event yet, and a payload the schema refuses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exampleGenerationProgress, type GenerationProgress } from '@/shapes';
import { resetSessionTokenCache, subscribeProgress } from '@/ui/api-client';

const TOKEN = 'a'.repeat(64);

/** A stream that hands back exactly the chunks given, in order, then ends. */
function streamOf(chunks: string[], tail?: () => never): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    read: async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      if (i < chunks.length) {
        const value = encoder.encode(chunks[i]);
        i += 1;
        return { done: false, value };
      }
      if (tail !== undefined) tail();
      return { done: true, value: undefined };
    },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

function mockFetch(reader: ReadableStreamDefaultReader<Uint8Array>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({ body: { getReader: () => reader } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function block(progress: GenerationProgress, event = 'progress'): string {
  return `event: ${event}\ndata: ${JSON.stringify(progress)}\n\n`;
}

function progressAt(modulesDone: number): GenerationProgress {
  return { ...exampleGenerationProgress, modulesDone };
}

/** Runs the subscription to completion: the reader is synchronous, so a few ticks suffice. */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

type Seen = { progress: GenerationProgress[]; errors: string[]; closes: number };

async function collect(chunks: string[], tail?: () => never): Promise<Seen & { calls: number }> {
  const seen: Seen = { progress: [], errors: [], closes: 0 };
  const fetchMock = mockFetch(streamOf(chunks, tail));
  const stop = subscribeProgress(exampleGenerationProgress.topicId, {
    onProgress: (p) => seen.progress.push(p),
    onError: (m) => seen.errors.push(m),
    onClose: () => {
      seen.closes += 1;
    },
  });
  await drain();
  stop();
  return { ...seen, calls: fetchMock.mock.calls.length };
}

describe('F2 progress stream framing', () => {
  beforeEach(() => {
    resetSessionTokenCache();
    document.head.innerHTML = `<meta name="la-token" content="${TOKEN}">`;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetSessionTokenCache();
    document.head.innerHTML = '';
  });

  it('carries a half-read event across a chunk boundary that falls mid-field', async () => {
    const whole = block(progressAt(3));
    const cut = whole.indexOf('modulesDone') + 4;
    const seen = await collect([whole.slice(0, cut), whole.slice(cut)]);
    expect(seen.progress.map((p) => p.modulesDone)).toEqual([3]);
    expect(seen.errors).toEqual([]);
  });

  it('delivers every event when several arrive in one chunk', async () => {
    const seen = await collect([block(progressAt(1)) + block(progressAt(2)) + block(progressAt(3), 'done')]);
    expect(seen.progress.map((p) => p.modulesDone)).toEqual([1, 2, 3]);
  });

  it('holds a trailing partial event back instead of delivering it half-parsed', async () => {
    const partial = block(progressAt(9)).slice(0, -6);
    const seen = await collect([block(progressAt(4)), partial]);
    expect(seen.progress.map((p) => p.modulesDone)).toEqual([4]);
    expect(seen.errors).toEqual([]);
    expect(seen.closes).toBe(1);
  });

  it('drops a payload the schema refuses, silently, and keeps reading', async () => {
    const bad = 'event: progress\ndata: {"phase":"authoring"}\n\n';
    const unparseable = 'event: progress\ndata: {not json\n\n';
    const seen = await collect([bad, unparseable, block(progressAt(7))]);
    // Deliberate: a malformed frame is skipped without an error the learner would see.
    // Changing that should be a decision, so it is asserted rather than assumed.
    expect(seen.errors).toEqual([]);
    expect(seen.progress.map((p) => p.modulesDone)).toEqual([7]);
  });

  it('ignores comments and unknown events, and reports a server error frame', async () => {
    const seen = await collect([': keep-alive\n\n', 'event: ping\ndata: {}\n\n', 'event: error\ndata: {}\n\n']);
    expect(seen.progress).toEqual([]);
    expect(seen.errors).toHaveLength(1);
  });

  it('treats a mid-stream drop as terminal: one error, one close, no reconnect', async () => {
    const seen = await collect([block(progressAt(2))], () => {
      throw new Error('socket reset');
    });
    expect(seen.progress.map((p) => p.modulesDone)).toEqual([2]);
    expect(seen.errors).toHaveLength(1);
    expect(seen.closes).toBe(1);
    expect(seen.calls).toBe(1);
  });
});
