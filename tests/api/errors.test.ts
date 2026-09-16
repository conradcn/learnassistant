// FRACTAL: covers F1 | type integration
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exampleTopicIntakeRequest } from '@/shapes';
import { loadConfig, resetConfigCache } from '@/core/config';
import { resetServices } from '@/api/services';
import { resetTokenCache, sessionToken } from '@/api/token';
import { errorResponse } from '@/api/respond';
import { progressSseEventSchema } from '@/api/shapes';
import { POST as postTopic } from '../../app/api/topics/route';
import { GET as getTopic } from '../../app/api/topics/[id]/route';
import { POST as postReflection } from '../../app/api/reflections/route';
import { POST as postGenerate } from '../../app/api/topics/[id]/generate/route';
import { GET as getStream } from '../../app/api/topics/[id]/stream/route';

const SECRET_TEXT = 'ZZ-LEARNER-SUBMITTED-SECRET-ZZ';

function req(urlPath: string, method: string, body?: unknown): Request {
  const port = loadConfig().port;
  return new Request(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      host: `127.0.0.1:${port}`,
      'content-type': 'application/json',
      'x-la-token': sessionToken(),
      origin: `http://127.0.0.1:${port}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const noParams = { params: Promise.resolve({}) };

describe('errors never leak internals', () => {
  let dataRoot: string;
  const bodies: string[] = [];

  beforeAll(async () => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-api-errors-'));
    process.env.LA_DATA_ROOT = dataRoot;
    resetConfigCache();
    resetTokenCache();
    resetServices();

    const responses = [
      await postTopic(req('/api/topics', 'POST', { subject: SECRET_TEXT }), noParams),
      await postReflection(
        req('/api/reflections', 'POST', { topicId: 'not-an-id', moduleId: null, text: SECRET_TEXT }),
        noParams,
      ),
      await getTopic(req('/api/topics/t_aaaaaaaaaaaaaaaa', 'GET'), {
        params: Promise.resolve({ id: 't_aaaaaaaaaaaaaaaa' }),
      }),
      await getTopic(req('/api/topics/nonsense', 'GET'), { params: Promise.resolve({ id: 'nonsense' }) }),
      await postTopic(req('/api/topics', 'POST', exampleTopicIntakeRequest), noParams),
      await postTopic(req('/api/topics', 'POST', exampleTopicIntakeRequest), noParams),
      await postGenerate(req('/api/topics/t_aaaaaaaaaaaaaaaa/generate', 'POST', { decisionToken: 'made-up' }), {
        params: Promise.resolve({ id: 't_aaaaaaaaaaaaaaaa' }),
      }),
    ];
    for (const res of responses) {
      if (res.status >= 400) bodies.push(await res.text());
    }
  });

  afterAll(() => {
    resetServices();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('produced a failure for each refused request', () => {
    expect(bodies.length).toBe(6);
  });

  it('never echoes the submitted value', () => {
    for (const body of bodies) expect(body).not.toContain(SECRET_TEXT);
  });

  it('never contains a filesystem path', () => {
    for (const body of bodies) {
      expect(body).not.toContain(dataRoot);
      expect(body).not.toContain(process.cwd());
      expect(body).not.toMatch(/[A-Za-z]:\\\\/);
      expect(body).not.toMatch(/\/(?:home|tmp|var|Users)\//);
    }
  });

  it('never contains a stack trace', () => {
    for (const body of bodies) {
      expect(body).not.toContain('    at ');
      expect(body).not.toContain('.ts:');
      expect(body).not.toContain('node_modules');
    }
  });

  it('carries a correlation id on every failure', () => {
    for (const body of bodies) {
      const parsed = JSON.parse(body) as { ok: boolean; error: { code: string; message: string; correlationId: string } };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.correlationId).toMatch(/^c_[0-9a-f]{8}$/);
      expect(parsed.error.message.length).toBeGreaterThan(0);
    }
  });

  it('turns an unexpected exception into a 500 with no detail', async () => {
    const raw = new Error(`ENOENT: open '${path.join(dataRoot, 'learn.db')}' failed`);
    const res = errorResponse(raw);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain(dataRoot);
    expect(body).not.toContain('ENOENT');
    const parsed = JSON.parse(body) as { error: { code: string; correlationId: string } };
    expect(parsed.error.code).toBe('internal');
    expect(parsed.error.correlationId).toMatch(/^c_[0-9a-f]{8}$/);
  });

  it('closes the progress stream when the client disconnects', async () => {
    const created = (await (
      await postTopic(req('/api/topics', 'POST', { ...exampleTopicIntakeRequest, subject: 'Streaming subject' }), noParams)
    ).json()) as { ok: boolean; data: { id: string } };
    expect(created.ok).toBe(true);

    const controller = new AbortController();
    const port = loadConfig().port;
    const streamReq = new Request(`http://127.0.0.1:${port}/api/topics/${created.data.id}/stream`, {
      method: 'GET',
      headers: {
        host: `127.0.0.1:${port}`,
        'x-la-token': sessionToken(),
        origin: `http://127.0.0.1:${port}`,
      },
      signal: controller.signal,
    });
    const res = await getStream(streamReq, { params: Promise.resolve({ id: created.data.id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    const frame = new TextDecoder().decode(first.value);
    expect(frame).toContain('event: progress');
    expect(progressSseEventSchema.parse({ event: 'progress', data: JSON.parse(frame.split('data: ')[1]) }).event).toBe(
      'progress',
    );

    controller.abort();
    const after = await reader.read();
    expect(after.done).toBe(true);
  });

});
