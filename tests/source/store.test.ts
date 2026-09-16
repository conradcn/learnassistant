// FRACTAL: covers F1 | type unit
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sourceIdSchema, topicIdSchema, type SourceId, type TopicId } from '@/shapes';
import { paths } from '@/core/paths';
import {
  STAGING_TTL_MS,
  discardStaged,
  readSourceText,
  readStaged,
  stageSource,
  stagedDir,
  sweepStaging,
  writeSourceDocument,
  type StagedMeta,
} from '@/source/store';

const TOPIC: TopicId = topicIdSchema.parse('t_9fQ2xK4mZa71bC0d');
const SOURCE: SourceId = sourceIdSchema.parse('sd_71bC0d9fQ2xK4mZa');

function meta(id: SourceId = SOURCE): StagedMeta {
  return {
    id,
    filename: 'syllabus.pdf',
    kind: 'pdf',
    byteSize: 2048,
    charCount: 42,
    pageCount: 3,
    truncated: false,
    units: [{ label: 'Unit 1', title: 'Probability review' }],
  };
}

describe('material on disk', () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-source-'));
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('keeps the extracted text and the original upload under the topic’s own directory', () => {
    writeSourceDocument(dataRoot, TOPIC, meta(), 'Unit 1: Probability review', Buffer.from('%PDF-1.4 raw'));

    const dir = paths(dataRoot).sourceDir(TOPIC);
    expect(dir).toBe(path.join(paths(dataRoot).topicsDir, TOPIC, 'source'));
    const entries = readdirSync(dir);
    expect(entries).toContain(`${SOURCE}.txt`);
    // The upload is kept as well as the text: extraction is lossy, and a learner told we
    // could not read their book should not also have lost it.
    expect(entries.some((e) => e.startsWith(`${SOURCE}-`) && e.endsWith('.pdf'))).toBe(true);
    expect(readSourceText(dataRoot, TOPIC, SOURCE)).toBe('Unit 1: Probability review');
  });

  it('reads back null, rather than throwing, for a document that is not on disk', () => {
    expect(readSourceText(dataRoot, TOPIC, SOURCE)).toBeNull();
  });

  it('writes nothing beyond the text when there is no original — a paste has none', () => {
    writeSourceDocument(dataRoot, TOPIC, { ...meta(), kind: 'pasted' }, 'Pasted syllabus', null);
    expect(readdirSync(paths(dataRoot).sourceDir(TOPIC))).toEqual([`${SOURCE}.txt`]);
  });

  it('keeps the learner’s own filename but never lets it become a path', () => {
    const nasty = { ...meta(), filename: '../../etc/passwd' };
    writeSourceDocument(dataRoot, TOPIC, nasty, 'text', Buffer.from('bytes'));

    const dir = paths(dataRoot).sourceDir(TOPIC);
    for (const entry of readdirSync(dir)) {
      expect(entry).not.toContain('..');
      expect(entry).not.toContain('/');
      expect(entry).not.toContain('\\');
      expect(path.dirname(path.resolve(dir, entry))).toBe(dir);
    }
    expect(existsSync(path.join(dataRoot, 'etc', 'passwd'))).toBe(false);
  });

  describe.each([
    ['a traversal', '../../../etc/passwd'],
    ['an absolute path', '/etc/passwd'],
    ['a windows path', 'C:\\Windows\\system32'],
    ['an encoded traversal', '%2e%2e%2fsecrets'],
    ['an empty id', ''],
    ['a nearly-valid id', 'sd_short'],
    ['an over-long id', `sd_${'a'.repeat(400)}`],
  ])('refuses %s before it can become a path', (_name, malformed) => {
    it('in staging', () => {
      expect(() => stagedDir(dataRoot, malformed)).toThrow();
    });

    it('in a topic’s source directory', () => {
      expect(() => readSourceText(dataRoot, TOPIC, malformed as SourceId)).toThrow();
    });
  });

  it('refuses a malformed topic id before it can become a path', () => {
    for (const bad of ['../../elsewhere', '/etc', 't_short', '']) {
      expect(() => paths(dataRoot).sourceDir(bad as TopicId)).toThrow();
    }
  });
});

describe('staging — where an upload waits for a subject', () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-staging-'));
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('parks an upload and hands the same thing back', () => {
    stageSource(dataRoot, meta(), 'Unit 1: Probability review', Buffer.from('%PDF-1.4 raw'));

    const back = readStaged(dataRoot, SOURCE);
    expect(back?.meta).toEqual(meta());
    expect(back?.text).toBe('Unit 1: Probability review');
    expect(back?.original?.toString()).toBe('%PDF-1.4 raw');
  });

  it('reads as absent when nothing was staged under that id', () => {
    expect(readStaged(dataRoot, SOURCE)).toBeNull();
  });

  it('reads as absent when the record on disk will not parse, rather than throwing', () => {
    stageSource(dataRoot, meta(), 'text', null);
    writeFileSync(path.join(stagedDir(dataRoot, SOURCE), 'meta.json'), '{not json');
    expect(readStaged(dataRoot, SOURCE)).toBeNull();
  });

  it('reads as absent when the record names a different id than the one asked for', () => {
    const other = sourceIdSchema.parse('sd_0d9fQ2xK4mZa71bC');
    stageSource(dataRoot, meta(), 'text', null);
    writeFileSync(
      path.join(stagedDir(dataRoot, SOURCE), 'meta.json'),
      JSON.stringify({ ...meta(), id: other }),
    );
    expect(readStaged(dataRoot, SOURCE)).toBeNull();
  });

  it('discards an upload completely once a topic has claimed it', () => {
    stageSource(dataRoot, meta(), 'text', Buffer.from('bytes'));
    discardStaged(dataRoot, SOURCE);
    expect(existsSync(stagedDir(dataRoot, SOURCE))).toBe(false);
    expect(readStaged(dataRoot, SOURCE)).toBeNull();
  });

  it('sweeps an upload nothing ever claimed, and leaves a fresh one alone', () => {
    const stale = sourceIdSchema.parse('sd_0d9fQ2xK4mZa71bC');
    stageSource(dataRoot, meta(stale), 'old text', null);
    stageSource(dataRoot, meta(), 'new text', null);

    const old = new Date(Date.now() - STAGING_TTL_MS - 60_000);
    utimesSync(stagedDir(dataRoot, stale), old, old);

    expect(sweepStaging(dataRoot)).toBe(1);
    expect(readStaged(dataRoot, stale)).toBeNull();
    expect(readStaged(dataRoot, SOURCE)?.text).toBe('new text');
  });

  it('leaves anything in the staging root that is not a staged upload untouched', () => {
    const root = paths(dataRoot).stagingDir;
    mkdirSync(root, { recursive: true });
    const bystander = path.join(root, 'not-a-source');
    writeFileSync(bystander, 'leave me alone');
    const old = new Date(Date.now() - STAGING_TTL_MS - 60_000);
    utimesSync(bystander, old, old);

    expect(sweepStaging(dataRoot)).toBe(0);
    expect(readFileSync(bystander, 'utf8')).toBe('leave me alone');
  });

  it('sweeps nothing, and does not fail, before anything has ever been staged', () => {
    expect(sweepStaging(dataRoot)).toBe(0);
  });

  it.runIf(process.platform !== 'win32')('writes files 0600 and directories 0700', () => {
    stageSource(dataRoot, meta(), 'text', Buffer.from('bytes'));
    const dir = stagedDir(dataRoot, SOURCE);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, 'text.txt')).mode & 0o777).toBe(0o600);
  });
});
