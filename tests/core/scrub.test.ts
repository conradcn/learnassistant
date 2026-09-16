// FRACTAL: covers (none) | type unit
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { resetConfigCache } from '@/core/config';
import { scrub, resetScrubSaltCache } from '@/core/scrub';

describe('scrub', () => {
  let dirA: string;
  let dirB: string;
  let originalDataRoot: string | undefined;

  beforeEach(() => {
    dirA = mkdtempSync(path.join(os.tmpdir(), 'la-scrub-a-'));
    dirB = mkdtempSync(path.join(os.tmpdir(), 'la-scrub-b-'));
    originalDataRoot = process.env.LA_DATA_ROOT;
  });

  afterEach(() => {
    if (originalDataRoot === undefined) delete process.env.LA_DATA_ROOT;
    else process.env.LA_DATA_ROOT = originalDataRoot;
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
    resetConfigCache();
    resetScrubSaltCache();
  });

  it('produces a 32-hex-char digest token', () => {
    process.env.LA_DATA_ROOT = dirA;
    resetConfigCache();
    resetScrubSaltCache();
    const result = scrub('my secret learner thought') as string;
    const match = result.match(/^\[REDACTED:pii:([0-9a-f]{32})\]$/);
    expect(match).not.toBeNull();
  });

  it('never leaks the salt into the output', () => {
    process.env.LA_DATA_ROOT = dirA;
    resetConfigCache();
    resetScrubSaltCache();
    const result = scrub({ text: 'hello there learner' });
    expect(JSON.stringify(result)).not.toMatch(/[0-9a-f]{32}\.tmp/);
  });

  it('produces different digests for the same text under different salts', () => {
    process.env.LA_DATA_ROOT = dirA;
    resetConfigCache();
    resetScrubSaltCache();
    const a = scrub('the same text') as string;

    process.env.LA_DATA_ROOT = dirB;
    resetConfigCache();
    resetScrubSaltCache();
    const b = scrub('the same text') as string;

    expect(a).not.toBe(b);
  });

  it('is not recoverable by preimage over a small dictionary without the salt', () => {
    process.env.LA_DATA_ROOT = dirA;
    resetConfigCache();
    resetScrubSaltCache();
    const result = scrub('yes') as string;
    const digestMatch = result.match(/pii:([0-9a-f]{32})/)!;
    const digest = digestMatch[1];

    const dictionary = ['yes', 'no', 'maybe', 'true', 'false'];
    for (const word of dictionary) {
      const bareSha = createHash('sha256').update(word).digest('hex').slice(0, 32);
      expect(bareSha).not.toBe(digest);
    }
  });

  it('preserves object/array structure', () => {
    process.env.LA_DATA_ROOT = dirA;
    resetConfigCache();
    resetScrubSaltCache();
    const result = scrub({ a: 'text', list: ['x', 'y'], nested: { b: 'z' }, n: 5, flag: true, nothing: null }) as Record<string, unknown>;
    expect(typeof result.a).toBe('string');
    expect(Array.isArray(result.list)).toBe(true);
    expect((result.list as string[]).length).toBe(2);
    expect(typeof (result.nested as Record<string, unknown>).b).toBe('string');
    expect(result.n).toBe(5);
    expect(result.flag).toBe(true);
    expect(result.nothing).toBeNull();
  });

  it('leaves allowlisted structural keys verbatim', () => {
    process.env.LA_DATA_ROOT = dirA;
    resetConfigCache();
    resetScrubSaltCache();
    const result = scrub({
      code: 'validation',
      correlationId: 'c_abcd1234',
      kind: 'video',
      status: 'ready',
      phase: 'authoring',
      id: 'x1',
      topicId: 't_abc',
      moduleId: 'm_abc',
      sessionId: 's_abc',
      event: 'login',
      component: 'C0',
      level: 'info',
      mode: 'question',
      op: 'save',
      durMs: 12,
      at: '2026-08-22T09:14:03.000Z',
      path: '/secret/path/free-text',
    }) as Record<string, unknown>;

    expect(result.code).toBe('validation');
    expect(result.correlationId).toBe('c_abcd1234');
    expect(result.kind).toBe('video');
    expect(result.status).toBe('ready');
    expect(result.phase).toBe('authoring');
    expect(result.id).toBe('x1');
    expect(result.topicId).toBe('t_abc');
    expect(result.moduleId).toBe('m_abc');
    expect(result.sessionId).toBe('s_abc');
    expect(result.event).toBe('login');
    expect(result.component).toBe('C0');
    expect(result.level).toBe('info');
    expect(result.mode).toBe('question');
    expect(result.op).toBe('save');
    expect(result.durMs).toBe(12);
    expect(result.at).toBe('2026-08-22T09:14:03.000Z');
    expect(result.path).not.toBe('/secret/path/free-text');
  });
  it('mints its salt into a data root that does not exist yet', () => {
    // WHY this exists: the salt is the first thing written under the data root, so on a
    // genuine first run — a fresh clone, or LA_DATA_ROOT pointed somewhere new — the
    // directory is not there. It used to fail with ENOENT, and because scrubbing sits
    // under every log line, the app answered 500 to the very first request it received.
    const unborn = path.join(dirA, 'never', 'created', 'yet');
    expect(existsSync(unborn)).toBe(false);

    process.env.LA_DATA_ROOT = unborn;
    resetConfigCache();
    resetScrubSaltCache();

    expect(() => scrub({ event: 'login', path: '/secret/path/free-text' })).not.toThrow();
    expect(existsSync(path.join(unborn, '.scrub-salt'))).toBe(true);
  });
});
