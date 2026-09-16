// FRACTAL: implements F1 | component C9
/**
 * The single source of truth for this app's Content-Security-Policy.
 *
 * WHY (H12): the app renders model-authored HTML through a hand-written sanitizer, and the
 * per-launch session credential lives in a `<meta>` tag in the document. The sanitizer is the
 * first line of defence; the CSP is the second, so a hole in the allowlist still cannot reach
 * a script, an outbound request, or a framing parent. API responses and HTML documents differ
 * only in what a document additionally needs (a nonce for Next's own inline bootstrap, inline
 * style attributes for KaTeX), so both are derived here rather than written out twice — two
 * hand-maintained copies drift, and the weaker one becomes the real policy.
 */
type Directives = Record<string, string[]>;

const BASE: Readonly<Directives> = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:'],
  'connect-src': ["'self'"],
  'font-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'frame-ancestors': ["'none'"],
};

function serialize(directives: Directives): string {
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

function clone(): Directives {
  return Object.fromEntries(Object.entries(BASE).map(([k, v]) => [k, [...v]]));
}

/** The policy for JSON and SSE responses: nothing in an API body is ever meant to execute. */
export function apiCsp(): string {
  return serialize(clone());
}

/**
 * The policy for HTML documents. Three deliberate widenings over the API policy:
 *
 * - `'nonce-…'` on script-src, because Next's App Router streams its payload through inline
 *   `<script>` tags. Next reads this nonce back off the request header and stamps its own
 *   tags with it, so the bootstrap runs and any OTHER inline script — including one that
 *   somehow survived the sanitizer — does not. A nonce also makes the browser ignore
 *   `'unsafe-inline'`, which is why none is offered as a fallback.
 * - `'unsafe-inline'` on style-src, because KaTeX positions every glyph with a `style="…"`
 *   attribute and style attributes are covered by style-src. Styles cannot execute, and the
 *   sanitizer does not allow `style` through its own attribute allowlist anyway.
 * - in development only, `'unsafe-eval'` and a websocket origin, which is what React Fast
 *   Refresh needs. Neither is present in a release build.
 */
export function documentCsp(nonce: string, dev = process.env.NODE_ENV !== 'production'): string {
  const d = clone();
  d['script-src'] = ["'self'", `'nonce-${nonce}'`, ...(dev ? ["'unsafe-eval'"] : [])];
  d['style-src'] = ["'self'", "'unsafe-inline'"];
  if (dev) d['connect-src'] = ["'self'", 'ws:'];
  return serialize(d);
}

/** A fresh nonce per document. Uniqueness and unpredictability are all that is required. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
