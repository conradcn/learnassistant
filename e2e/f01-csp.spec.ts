// FRACTAL: covers F1 | type e2e
/**
 * Every HTML document this app serves carries a Content-Security-Policy, and the app runs
 * clean under it.
 *
 * WHY: the app renders model-authored HTML through a hand-written sanitizer, and the session
 * credential sits in a <meta> tag in that same document. The CSP is the second line of
 * defence behind the sanitizer. A policy that quietly breaks the app is worse than none —
 * it gets loosened until it means nothing — so this asserts both halves: the header is
 * really there on documents, and nothing in the app (Next's own bootstrap, KaTeX, the
 * stylesheets) violates it.
 */
import { test, expect } from './fixtures';
import { SUBJECT_A } from './seed';

const PAGES = ['/', '/review', '/practice', '/cards', '/synthesis', '/journal', '/settings'];

test('every document carries a CSP and nothing in the app violates it', async ({ page, enter, clickTo }) => {
  const violations: string[] = [];
  const consoleErrors: string[] = [];
  // The browser's own report, which fires whether or not the console line is scraped.
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { __csp?: string[] }).__csp ??= [];
      (window as unknown as { __csp: string[] }).__csp.push(
        `${e.violatedDirective} blocked ${e.blockedURI} (${e.sourceFile ?? '?'}:${e.lineNumber ?? 0})`,
      );
    });
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  const nonces = new Set<string>();
  for (const path of PAGES) {
    const response = await page.goto(path);
    expect(response, `no response for ${path}`).not.toBeNull();
    const csp = response?.headers()['content-security-policy'] ?? '';
    expect(csp, `no CSP on the document for ${path}`).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    // A nonce, not 'unsafe-inline' — the latter would let any injected inline script run.
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
    expect(nonce, `no script nonce on ${path}`).toBeTruthy();
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    nonces.add(nonce ?? '');

    await page.waitForLoadState('networkidle');
    violations.push(
      ...(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])).map(
        (v) => `${path}: ${v}`,
      ),
    );
  }

  // A nonce that repeats across documents is not a nonce.
  expect(nonces.size).toBe(PAGES.length);

  // The app is genuinely alive under the policy: React hydrated and the client nav works.
  // WHY this stops at the topic page: the whole suite shares one seeded data root, and
  // opening a lesson advances that learner's progress for every spec that runs after this
  // one. KaTeX under the policy — the likeliest thing to trip style-src, since it positions
  // every glyph with an inline style attribute — is asserted in f03-display-math, which
  // opens a lesson by design.
  await enter('/');
  await clickTo(page.getByRole('link', { name: SUBJECT_A }).click(), /\/topics\/t_[A-Za-z0-9]{16}$/);
  await expect(page.getByTestId('graph-open-node').first()).toBeVisible();

  violations.push(
    ...(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])).map(
      (v) => `/topics: ${v}`,
    ),
  );

  expect(violations, violations.join('\n')).toEqual([]);
  expect(
    consoleErrors.filter((e) => /content security policy|refused to (execute|load|apply)/i.test(e)),
  ).toEqual([]);
});

test('API responses keep the same policy, from the same source', async ({ request }) => {
  const response = await request.get('/api/topics', { failOnStatusCode: false });
  const csp = response.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'self'");
  // No nonce and no relaxation on an API body: nothing in one is ever meant to execute.
  expect(csp).toContain("script-src 'self';");
  expect(csp).not.toContain('nonce-');
});
