// FRACTAL: covers F1 | type unit
import { describe, expect, it } from 'vitest';
import { apiCsp, documentCsp, newNonce } from '@/core/csp';
import { SECURITY_HEADERS } from '@/api/respond';

/**
 * WHY: the whole point of @/core/csp is that the API policy and the document policy cannot
 * drift into two different ideas of what the app may do. These pin the shared base and the
 * three deliberate widenings the document form makes over it — so loosening the API policy,
 * or adding a fourth widening, has to be a deliberate change to a test.
 */
describe('content security policy', () => {
  it('is the policy the API actually sends', () => {
    expect(SECURITY_HEADERS['Content-Security-Policy']).toBe(apiCsp());
  });

  it('locks the API policy down completely', () => {
    expect(apiCsp()).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; " +
        "form-action 'none'; frame-ancestors 'none'",
    );
  });

  it('gives a release document a nonce and no other script relaxation', () => {
    const csp = documentCsp('abc123', false);
    expect(csp).toContain("script-src 'self' 'nonce-abc123';");
    expect(csp).not.toContain('unsafe-eval');
    // A nonce makes the browser ignore 'unsafe-inline', so offering one would be misleading.
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("connect-src 'self';");
  });

  it('relaxes only style-src for inline attributes, which KaTeX needs and cannot execute', () => {
    expect(documentCsp('n', false)).toContain("style-src 'self' 'unsafe-inline';");
  });

  it('keeps every deny-directive identical between the API and document forms', () => {
    const doc = documentCsp('n', false);
    for (const directive of [
      "default-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ]) {
      expect(apiCsp()).toContain(directive);
      expect(doc).toContain(directive);
    }
  });

  it('adds the Fast Refresh allowances in development and nowhere else', () => {
    const dev = documentCsp('n', true);
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain('ws:');
    expect(documentCsp('n', false)).not.toContain('ws:');
  });

  it('mints a fresh, non-trivial nonce each time', () => {
    const nonces = new Set(Array.from({ length: 64 }, () => newNonce()));
    expect(nonces.size).toBe(64);
    for (const n of nonces) expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});
