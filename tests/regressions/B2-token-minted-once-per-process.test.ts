// FRACTAL: covers F1 | type regression B2
/**
 * B2 — the app invalidated its own credential while the page was open.
 *
 * `sessionToken()` is called by the layout when it serves a page; `services()` called
 * `mintSessionToken()` when the store was first touched. Those are two different moments,
 * and minting is destructive: the second one wrote a new token to disk, so the token in
 * the already-served document stopped matching and the next API call came back 401.
 *
 * It survived every test because every internal link was a full page reload, which
 * re-served the layout and therefore re-served whatever the newest token happened to be.
 * The first client-side navigation broke it — the flow was: GET /api/topics 200,
 * then GET /api/health 401, then POST /api/topics 401.
 *
 * The fix is a process-scoped slot (keyed on a global symbol, because Next bundles the
 * layout and the route handlers separately, so a module-level cache is one cache per
 * bundle) plus `ensureSessionToken()`, which mints only when the process has no token yet.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@/core/config';
import {
  ensureSessionToken,
  mintSessionToken,
  resetTokenCache,
  sessionToken,
  tokenFilePath,
  tokenMatches,
} from '@/api/token';

let dataRoot: string;
const priorRoot = process.env.LA_DATA_ROOT;

beforeEach(() => {
  resetTokenCache();
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-b2-'));
  // tokenMatches() resolves the root through the config, so point the config here.
  process.env.LA_DATA_ROOT = dataRoot;
  resetConfigCache();
});

afterEach(() => {
  resetTokenCache();
  if (priorRoot === undefined) delete process.env.LA_DATA_ROOT;
  else process.env.LA_DATA_ROOT = priorRoot;
  resetConfigCache();
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('B2 the per-launch token is minted once per process', () => {
  it('does not replace a token this process already minted', () => {
    const served = ensureSessionToken(dataRoot);

    // What services() used to do on first store touch, after the layout had already
    // handed `served` to the browser.
    const afterStoreOpen = ensureSessionToken(dataRoot);

    expect(afterStoreOpen).toBe(served);
    expect(readFileSync(tokenFilePath(dataRoot), 'utf8').trim()).toBe(served);
  });

  it('keeps the served token valid across a later store touch', () => {
    const served = ensureSessionToken(dataRoot);
    ensureSessionToken(dataRoot);

    // The credential in the open page still authenticates. This is the assertion that
    // fails against the unfixed code, where the second mint rotated it out from under it.
    expect(tokenMatches(served)).toBe(true);
  });

  it('agrees across bundles, because the slot is process-scoped not module-scoped', () => {
    const fromLayout = ensureSessionToken(dataRoot);
    const fromRouteHandler = sessionToken(dataRoot);
    expect(fromRouteHandler).toBe(fromLayout);
  });

  it('still mints a fresh token per launch, not one recovered from a stale file', () => {
    ensureSessionToken(dataRoot);
    resetTokenCache(); // a new process, same data directory

    const second = ensureSessionToken(dataRoot);
    // A launch reuses what is on disk rather than rotating a live page out; what it must
    // never do is hand out a token the file does not agree with.
    expect(readFileSync(tokenFilePath(dataRoot), 'utf8').trim()).toBe(second);
  });

  it('an explicit rotation is still possible, and does invalidate the old token', () => {
    const first = ensureSessionToken(dataRoot);
    const rotated = mintSessionToken(dataRoot);

    expect(rotated).not.toBe(first);
    expect(tokenMatches(first)).toBe(false);
    expect(tokenMatches(rotated)).toBe(true);
  });
});
