// FRACTAL: covers F1 | type integration
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiOkSchema,
  dashboardViewSchema,
  exampleNewReflection,
  examplePrediction,
  exampleTopicIntakeRequest,
  moduleAvailabilitySchema,
  moduleGraphSchema,
  predictionSchema,
  reflectionSchema,
  reviewCueSchema,
  topicSchema,
  type Topic,
} from '@/shapes';
import { loadConfig, resetConfigCache } from '@/core/config';
import { resetServices } from '@/api/services';
import { resetTokenCache, sessionToken } from '@/api/token';
import { exampleHealthView, exampleSseEvent, healthViewSchema, progressSseEventSchema } from '@/api/shapes';
import { GET as getTopics, POST as postTopic } from '../../app/api/topics/route';
import { GET as getTopic } from '../../app/api/topics/[id]/route';
import { POST as postReflection } from '../../app/api/reflections/route';
import { POST as postPrediction } from '../../app/api/predictions/route';
import { GET as getReviewsDue } from '../../app/api/reviews/due/route';
import { GET as getHealth } from '../../app/api/health/route';

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

async function data(res: Response): Promise<unknown> {
  const body = (await res.json()) as { ok: boolean; data?: unknown; error?: unknown };
  expect(body.ok, JSON.stringify(body.error)).toBe(true);
  return body.data;
}

const noParams = { params: Promise.resolve({}) };

describe('every route validates its request and response against the registry shapes', () => {
  let dataRoot: string;
  let topic: Topic;

  beforeAll(async () => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-api-validate-'));
    process.env.LA_DATA_ROOT = dataRoot;
    resetConfigCache();
    resetTokenCache();
    resetServices();
    topic = topicSchema.parse(
      await data(await postTopic(req('/api/topics', 'POST', exampleTopicIntakeRequest), noParams)),
    );
  });

  afterAll(() => {
    resetServices();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('creates a topic in queued from the intake shape', () => {
    expect(topic.status).toBe('queued');
    expect(topic.subject).toBe(exampleTopicIntakeRequest.subject);
  });

  it('refuses a second identical subject and level', async () => {
    const res = await postTopic(req('/api/topics', 'POST', exampleTopicIntakeRequest), noParams);
    expect(res.status).toBe(409);
  });

  it('rejects an empty subject without touching the store', async () => {
    const res = await postTopic(req('/api/topics', 'POST', { ...exampleTopicIntakeRequest, subject: '  ' }), noParams);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('subject');
  });

  it('returns a DashboardView', async () => {
    const view = dashboardViewSchema.parse(await data(await getTopics(req('/api/topics', 'GET'), noParams)));
    expect(view.topics.map((t) => t.id)).toContain(topic.id);
  });

  it('returns a topic with its graph and availability', async () => {
    const detail = (await data(
      await getTopic(req(`/api/topics/${topic.id}`, 'GET'), { params: Promise.resolve({ id: topic.id }) }),
    )) as { topic: unknown; graph: unknown; availability: unknown };
    expect(topicSchema.parse(detail.topic).id).toBe(topic.id);
    moduleGraphSchema.parse(detail.graph);
    moduleAvailabilitySchema.array().parse(detail.availability);
  });

  it('returns a 404 for an unknown but well-formed topic id', async () => {
    const res = await getTopic(req('/api/topics/t_aaaaaaaaaaaaaaaa', 'GET'), {
      params: Promise.resolve({ id: 't_aaaaaaaaaaaaaaaa' }),
    });
    expect(res.status).toBe(404);
  });

  it('round-trips a reflection and a prediction', async () => {
    const reflection = reflectionSchema.parse(
      await data(
        await postReflection(req('/api/reflections', 'POST', { ...exampleNewReflection, topicId: topic.id }), noParams),
      ),
    );
    expect(reflection.text).toBe(exampleNewReflection.text);
    const prediction = predictionSchema.parse(
      await data(await postPrediction(req('/api/predictions', 'POST', examplePrediction), noParams)),
    );
    expect(prediction.confidence).toBe(examplePrediction.confidence);
  });

  it('returns an empty review queue as data, not as an error', async () => {
    const items = reviewCueSchema
      .array()
      .parse(await data(await getReviewsDue(req('/api/reviews/due', 'GET'), noParams)));
    expect(items).toEqual([]);
  });

  it('returns a HealthView', async () => {
    const view = healthViewSchema.parse(await data(await getHealth(req('/api/health', 'GET'), noParams)));
    expect(view.appVersion).toBe(exampleHealthView.appVersion);
  });

  it('round-trips every example value this component owns', () => {
    expect(healthViewSchema.parse(exampleHealthView)).toEqual(exampleHealthView);
    expect(progressSseEventSchema.parse(exampleSseEvent)).toEqual(exampleSseEvent);
    expect(apiOkSchema(healthViewSchema).parse({ ok: true, data: exampleHealthView }).data).toEqual(exampleHealthView);
  });
});
