// FRACTAL: covers F1 | type regression
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moduleIdSchema, topicIdSchema } from '@/shapes';
import { loadConfig, resetConfigCache } from '@/core/config';
import { isContained, paths } from '@/core/paths';
import { moduleDir, topicDir } from '@/api/confine';
import { resetServices } from '@/api/services';
import { resetTokenCache, sessionToken } from '@/api/token';
import { DELETE as deleteTopic, GET as getTopic } from '../../app/api/topics/[id]/route';
import { GET as getModule } from '../../app/api/modules/[id]/route';
import { POST as postSubmit } from '../../app/api/capstone/[topicId]/submit/route';
import { POST as postRecord } from '../../app/api/reviews/[moduleId]/record/route';
import { POST as postSend } from '../../app/api/eval/[sessionId]/send/route';
import { POST as postAnswer } from '../../app/api/practice/[sessionId]/answer/route';
import { PATCH as patchReflection } from '../../app/api/reflections/[id]/route';
import { GET as getDeck } from '../../app/api/cards/decks/[deckId]/route';
import { POST as postGrade } from '../../app/api/cards/[cardId]/grade/route';

const ABUSIVE: readonly string[] = [
  '',
  '..',
  '../..',
  '../../etc/passwd',
  '%2e%2e',
  '%2e%2e%2f%2e%2e',
  '%252e%252e',
  '/etc/passwd',
  'C:\\Windows\\win.ini',
  '\\\\server\\share',
  't_9fQ2xK4mZa71bC0d/../../../etc',
  't_9fQ2xK4mZa71bC0d\0',
  'a'.repeat(5000),
  'file:///etc/passwd',
];

type AllParams = { id: string; topicId: string; moduleId: string; sessionId: string; deckId: string; cardId: string };

type Target = {
  label: string;
  param: keyof AllParams;
  method: string;
  body: unknown;
  fn: (req: Request, ctx: { params: Promise<AllParams> }) => Promise<Response>;
};

function allParams(value: string): AllParams {
  return { id: value, topicId: value, moduleId: value, sessionId: value, deckId: value, cardId: value };
}

const TARGETS: readonly Target[] = [
  { label: 'GET /api/topics/:id', param: 'id', method: 'GET', body: undefined, fn: getTopic },
  { label: 'DELETE /api/topics/:id', param: 'id', method: 'DELETE', body: undefined, fn: deleteTopic },
  { label: 'GET /api/modules/:id', param: 'id', method: 'GET', body: undefined, fn: getModule },
  {
    label: 'POST /api/capstone/:topicId/submit',
    param: 'topicId',
    method: 'POST',
    body: { artifact: 'x', decisionToken: 'y' },
    fn: postSubmit,
  },
  {
    label: 'POST /api/reviews/:moduleId/record',
    param: 'moduleId',
    method: 'POST',
    body: { correct: true },
    fn: postRecord,
  },
  {
    label: 'POST /api/eval/:sessionId/send',
    param: 'sessionId',
    method: 'POST',
    body: { text: 'x', selfAssessment: null, decisionToken: 'y' },
    fn: postSend,
  },
  {
    label: 'POST /api/practice/:sessionId/answer',
    param: 'sessionId',
    method: 'POST',
    body: { index: 0, correct: true },
    fn: postAnswer,
  },
  { label: 'PATCH /api/reflections/:id', param: 'id', method: 'PATCH', body: { text: 'x' }, fn: patchReflection },
  { label: 'GET /api/cards/decks/:deckId', param: 'deckId', method: 'GET', body: undefined, fn: getDeck },
  {
    label: 'POST /api/cards/:cardId/grade',
    param: 'cardId',
    method: 'POST',
    body: { grade: 'knew-it' },
    fn: postGrade,
  },
];

function req(method: string, body: unknown): Request {
  const port = loadConfig().port;
  return new Request(`http://127.0.0.1:${port}/api/sink-probe`, {
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

describe('an abusive :id never reaches the filesystem', () => {
  let dataRoot: string;
  let before: string[];

  beforeAll(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-api-sink-'));
    process.env.LA_DATA_ROOT = dataRoot;
    resetConfigCache();
    resetTokenCache();
    resetServices();
    before = readdirSync(dataRoot).sort();
  });

  afterAll(() => {
    resetServices();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('refuses every abusive id on every :id route with a validation error', async () => {
    for (const target of TARGETS) {
      for (const value of ABUSIVE) {
        const res = await target.fn(req(target.method, target.body), {
          params: Promise.resolve(allParams(value)),
        });
        const label = `${target.label} <- ${JSON.stringify(value)}`;
        expect(res.status, label).toBe(400);
        const body = (await res.json()) as { ok: boolean; error: { code: string } };
        expect(body.ok, label).toBe(false);
        expect(body.error.code, label).toBe('validation');
      }
    }
  });

  it('never leaks the attempted value or a path in the refusal', async () => {
    const res = await getTopic(req('GET', undefined), { params: Promise.resolve(allParams('../../etc/passwd')) });
    const raw = await res.text();
    expect(raw).not.toContain('etc/passwd');
    expect(raw).not.toContain(dataRoot);
  });

  it('creates nothing beyond the application files while being probed', () => {
    const allowed = new Set([
      ...before,
      '.scrub-salt',
      '.session-token',
      'learn.db',
      'learn.db-shm',
      'learn.db-wal',
      'learn.db.prev',
      'logs',
    ]);
    // Snapshots are one file per schema version kept: learn.db.v5.prev, learn.db.v6.prev.
    const isGeneration = (name: string): boolean => /^learn\.db\.v\d+\.prev$/.test(name);
    for (const entry of readdirSync(dataRoot)) {
      expect(allowed.has(entry) || isGeneration(entry), entry).toBe(true);
    }
    const topicsDir = paths(dataRoot).topicsDir;
    expect(existsSync(topicsDir) ? readdirSync(topicsDir) : []).toEqual([]);
  });

  it('confines a well-formed id to the topics root on the resolved path', () => {
    const topicsDir = paths(dataRoot).topicsDir;
    const topicId = topicIdSchema.parse('t_9fQ2xK4mZa71bC0d');
    const moduleId = moduleIdSchema.parse('m_71bC0d9fQ2xK4mZa');
    expect(isContained(topicsDir, topicDir(dataRoot, topicId))).toBe(true);
    expect(isContained(topicsDir, moduleDir(dataRoot, topicId, moduleId))).toBe(true);
  });

  it('refuses a resolved path that would escape the topics root', () => {
    const escaping = 't_9fQ2xK4mZa71bC0d/../../../..' as ReturnType<typeof topicIdSchema.parse>;
    expect(() => topicDir(dataRoot, escaping)).toThrow();
  });
});
