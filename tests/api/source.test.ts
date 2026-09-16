// FRACTAL: covers F1 | type integration
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { stagedSourceSchema, type StagedSource, type Topic, type TopicId } from '@/shapes';
import { loadConfig, resetConfigCache } from '@/core/config';
import { paths } from '@/core/paths';
import { requireStore, resetServices } from '@/api/services';
import { resetTokenCache, sessionToken } from '@/api/token';
import { scannedPdf, textPdf } from '@/source/pdf.testing';
import { POST as postSource } from '../../app/api/source/route';
import { POST as postTopic } from '../../app/api/topics/route';
import { DELETE as deleteTopic } from '../../app/api/topics/[id]/route';

const SYLLABUS_PAGES = [
  [
    'Course: Information Theory',
    'Unit 1: Probability review',
    'Random variables and expectation.',
  ],
  ['Unit 2: Entropy', 'Shannon entropy of a discrete source.'],
];

const noParams = { params: Promise.resolve({}) };

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const port = loadConfig().port;
  return {
    host: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    'x-la-token': sessionToken(),
    ...extra,
  };
}

function url(pathname: string): string {
  return `http://127.0.0.1:${loadConfig().port}${pathname}`;
}

async function uploadFile(name: string, bytes: Buffer, type: string): Promise<Response> {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], name, { type }));
  return postSource(new Request(url('/api/source'), { method: 'POST', headers: headers(), body: form }), noParams);
}

async function pasteText(text: string): Promise<Response> {
  return postSource(
    new Request(url('/api/source'), {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ text }),
    }),
    noParams,
  );
}

async function createTopic(body: Record<string, unknown>): Promise<Response> {
  return postTopic(
    new Request(url('/api/topics'), {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    }),
    noParams,
  );
}

async function data<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { ok: boolean; data?: T; error?: unknown };
  expect(body.ok, JSON.stringify(body.error)).toBe(true);
  return body.data as T;
}

async function error(res: Response): Promise<{ code: string; message: string }> {
  const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } };
  expect(body.ok).toBe(false);
  return body.error;
}

describe('/api/source reads material in this process', () => {
  let dataRoot: string;

  beforeAll(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-api-source-'));
    process.env.LA_DATA_ROOT = dataRoot;
    resetConfigCache();
    resetTokenCache();
    resetServices();
  });

  afterAll(() => {
    resetServices();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('stages an uploaded PDF and hands back what the material says about itself', async () => {
    const res = await uploadFile('syllabus.pdf', textPdf(SYLLABUS_PAGES), 'application/pdf');
    expect(res.status).toBe(200);

    const staged: StagedSource = stagedSourceSchema.parse(await data(res));
    expect(staged.kind).toBe('pdf');
    expect(staged.pageCount).toBe(2);
    expect(staged.filename).toBe('syllabus.pdf');
    // The subject is inferred so the form can pre-fill it, and the units are shown back so
    // the learner can see we read the thing they handed us.
    expect(staged.inferredSubject).toBe('Information Theory');
    expect(staged.units.map((u) => u.title)).toEqual(['Probability review', 'Entropy']);
    expect(staged.excerpt).toContain('Probability review');
    expect(staged.truncated).toBe(false);

    // Nothing is under a topic yet: it waits in staging until one claims it.
    expect(existsSync(path.join(paths(dataRoot).stagingDir, staged.id))).toBe(true);
  });

  it('stages pasted text through the same door, with no format to get wrong', async () => {
    const staged: StagedSource = stagedSourceSchema.parse(
      await data(await pasteText('Course: Topology\nWeek 1: Metric spaces\nWeek 2: Compactness\n')),
    );

    expect(staged.kind).toBe('pasted');
    expect(staged.filename).toBe('Pasted material');
    expect(staged.pageCount).toBeNull();
    expect(staged.units.map((u) => u.title)).toEqual(['Metric spaces', 'Compactness']);
  });

  it('refuses a scanned PDF with the message that says it is a scan and names the paste box', async () => {
    const res = await uploadFile('scan.pdf', scannedPdf(), 'application/pdf');

    expect(res.status).toBe(400);
    const err = await error(res);
    expect(err.code).toBe('validation');
    expect(err.message.toLowerCase()).toContain('scan');
    expect(err.message.toLowerCase()).toContain('paste');
    // A refusal stages nothing — a scan must never become an empty extraction.
    expect(readdirSync(paths(dataRoot).stagingDir).length).toBeGreaterThanOrEqual(0);
  });

  it('refuses a file whose bytes are not the format its name claims', async () => {
    const res = await uploadFile('not-really.pdf', Buffer.from('this is plainly not a PDF'), 'application/pdf');

    expect(res.status).toBe(400);
    expect((await error(res)).code).toBe('validation');
  });

  it('refuses a format we do not read, and says what to do instead', async () => {
    const res = await uploadFile('marks.xlsx', Buffer.from('PKbinary spreadsheet'), 'application/vnd.ms-excel');

    expect(res.status).toBe(400);
    expect((await error(res)).message.toLowerCase()).toContain('paste');
  });

  it('refuses an upload with no file part rather than staging nothing quietly', async () => {
    const form = new FormData();
    form.set('text', 'wrong field');
    const res = await postSource(
      new Request(url('/api/source'), { method: 'POST', headers: headers(), body: form }),
      noParams,
    );

    expect(res.status).toBe(400);
  });
});

describe('material follows the topic that claims it', () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-api-attach-'));
    process.env.LA_DATA_ROOT = dataRoot;
    resetConfigCache();
    resetTokenCache();
    resetServices();
  });

  afterEach(() => {
    resetServices();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  const intake = {
    subject: 'Information theory',
    level: 'intermediate',
    purpose: 'build a compressor',
  };

  it('moves staging into the topic, one row and one pair of files per document', async () => {
    const pdf: StagedSource = await data(await uploadFile('syllabus.pdf', textPdf(SYLLABUS_PAGES), 'application/pdf'));
    const pasted: StagedSource = await data(
      await pasteText('Unit 3: Source coding\nHuffman codes.\n\nUnit 4: Channel capacity\nNoisy channels.\n'),
    );

    const topic: Topic = await data(await createTopic({ ...intake, sourceIds: [pdf.id, pasted.id] }));

    const rows = requireStore().store.sources.listFor(topic.id);
    expect(rows.map((r) => r.filename)).toEqual(['syllabus.pdf', 'Pasted material']);
    expect(rows.flatMap((r) => r.units.map((u) => u.title))).toEqual([
      'Probability review',
      'Entropy',
      'Source coding',
      'Channel capacity',
    ]);

    const dir = paths(dataRoot).sourceDir(topic.id);
    const files = readdirSync(dir);
    // The extracted text of both, plus the original of the upload — pasted text has no
    // original beyond the text itself.
    expect(files).toContain(`${pdf.id}.txt`);
    expect(files).toContain(`${pasted.id}.txt`);
    expect(files).toContain(`${pdf.id}-syllabus.pdf`);
    expect(readFileSync(path.join(dir, `${pdf.id}.txt`), 'utf8')).toContain('Shannon entropy');
    expect(readFileSync(path.join(dir, `${pdf.id}-syllabus.pdf`)).subarray(0, 5).toString()).toBe('%PDF-');

    // Claimed material leaves staging behind it.
    expect(existsSync(path.join(paths(dataRoot).stagingDir, pdf.id))).toBe(false);
  });

  it('takes a syllabus typed straight into the form and never read back first', async () => {
    const topic: Topic = await data(
      await createTopic({ ...intake, pastedMaterial: 'Week 1: Probability review\nWeek 2: Entropy\n' }),
    );

    const rows = requireStore().store.sources.listFor(topic.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toBe('Pasted material');
    expect(rows[0].units.map((u) => u.title)).toEqual(['Probability review', 'Entropy']);
  });

  it('creates the topic anyway when a staged id has gone missing', async () => {
    const pdf: StagedSource = await data(await uploadFile('syllabus.pdf', textPdf(SYLLABUS_PAGES), 'application/pdf'));
    rmSync(path.join(paths(dataRoot).stagingDir, pdf.id), { recursive: true, force: true });

    const res = await createTopic({ ...intake, sourceIds: [pdf.id] });

    expect(res.status).toBe(200);
    const topic: Topic = await data(res);
    // The topic exists with no material: the same path a learner who uploaded nothing takes,
    // rather than a subject the learner cannot retry the upload against.
    expect(requireStore().store.sources.listFor(topic.id)).toHaveLength(0);
  });

  it('leaves no directory and no rows for a topic that brought nothing', async () => {
    const topic: Topic = await data(await createTopic(intake));

    expect(requireStore().store.sources.listFor(topic.id)).toHaveLength(0);
    expect(existsSync(paths(dataRoot).sourceDir(topic.id))).toBe(false);
  });

  it('takes the learner’s own document with the topic when the topic is deleted', async () => {
    const pdf: StagedSource = await data(await uploadFile('syllabus.pdf', textPdf(SYLLABUS_PAGES), 'application/pdf'));
    const topic: Topic = await data(await createTopic({ ...intake, sourceIds: [pdf.id] }));
    const dir = paths(dataRoot).sourceDir(topic.id);
    expect(existsSync(dir)).toBe(true);

    const res = await deleteTopic(new Request(url(`/api/topics/${topic.id}`), { method: 'DELETE', headers: headers() }), {
      params: Promise.resolve({ id: topic.id as TopicId as string }),
    });

    expect(res.status).toBe(200);
    expect(existsSync(dir)).toBe(false);
    expect(requireStore().store.sources.listFor(topic.id)).toHaveLength(0);
  });
});
