// FRACTAL: covers F1 | type regression B1
// @vitest-environment jsdom
/**
 * B1 — every in-app link had to be a full page reload, or the app lost its credential.
 *
 * Two defects, one symptom ("This page lost its connection to the app"), both hidden for
 * as long as every internal link was a plain `<a href>` that reloaded the document:
 *
 *  1. The per-launch token is served in a `<meta name="la-token">`. React hoists and
 *     re-parents metadata tags, so after a client-side route change the node can be gone
 *     from `document` and the reader returned null.
 *  2. `services()` called `mintSessionToken()` on first store touch, minting a *second*
 *     token that invalidated the one already sitting in the open page. See the companion
 *     assertions in tests/api/ for the process-scoped slot that fixes it.
 *
 * Converting the navigation to `next/link` — which `@next/next/no-html-link-for-pages`
 * requires, and which is what makes the app feel like an app — exposed both at once.
 *
 * This test fails against the unfixed reader: remove the meta, and it returns null.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOKEN_META_NAME, readSessionToken, resetSessionTokenCache } from '@/ui/api-client';

const TOKEN = 'a'.repeat(64);

function serveToken(token: string): void {
  document.head.innerHTML = `<meta name="${TOKEN_META_NAME}" content="${token}">`;
}

function dropMeta(): void {
  document.querySelector(`meta[name="${TOKEN_META_NAME}"]`)?.remove();
}

beforeEach(() => {
  resetSessionTokenCache();
  document.head.innerHTML = '';
});
afterEach(() => resetSessionTokenCache());

describe('B1 the per-launch token survives a client-side navigation', () => {
  it('still resolves after React removes the meta node from the document', () => {
    serveToken(TOKEN);
    expect(readSessionToken()).toBe(TOKEN);

    // What React does to a hoisted metadata tag during a route transition.
    dropMeta();
    expect(document.querySelector(`meta[name="${TOKEN_META_NAME}"]`)).toBeNull();

    expect(readSessionToken()).toBe(TOKEN);
  });

  it('reads nothing when the document never carried a token', () => {
    expect(readSessionToken()).toBeNull();
  });

  it('never caches a malformed token', () => {
    serveToken('not-a-token');
    expect(readSessionToken()).toBeNull();

    serveToken(TOKEN);
    expect(readSessionToken()).toBe(TOKEN);
  });

  it('can be told to bypass the cache and read the document again', () => {
    serveToken(TOKEN);
    expect(readSessionToken()).toBe(TOKEN);

    const rotated = 'b'.repeat(64);
    serveToken(rotated);
    expect(readSessionToken(document, false)).toBe(rotated);
  });
});
