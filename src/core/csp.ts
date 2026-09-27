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

/**
 * Where an interactive block may load a library from. Named rather than `https:` so the set of
 * third parties a learner's browser will talk to is a list someone can read — and so the
 * authoring prompt can quote it, instead of the model inventing a CDN that does not exist.
 */
export const VIZ_SCRIPT_HOSTS: readonly string[] = [
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://cdnjs.cloudflare.com',
];

/**
 * The policy for the frame an interactive lesson block runs in (F3, `/viz-frame`).
 *
 * WHY it is the one place this app allows arbitrary script: an `interactive` block is
 * model-written HTML and JavaScript, run as written, by decision — a simulation, a draggable
 * construction or an animation cannot be expressed as data, and the plot's formula language
 * was the ceiling of what a declarative block can do. What keeps that from reaching the
 * learner's data is not this policy but the frame's `sandbox="allow-scripts"` WITHOUT
 * `allow-same-origin`: the document runs in an opaque origin, so it cannot read the session
 * credential in the parent's `<meta>`, cannot call the API with the parent's cookies, and
 * cannot touch the parent's DOM. This policy is the second fence:
 *
 * - `connect-src 'none'`: a visualization has nothing to fetch, and a script that cannot
 *   make a request cannot phone anything home — whatever it computed stays on the page.
 * - scripts from `VIZ_SCRIPT_HOSTS` only, so a library is loadable but an arbitrary host is not.
 * - `frame-ancestors 'self'`: only this app may frame it; everything else keeps `'none'`.
 */
export function vizFrameCsp(): string {
  return serialize({
    'default-src': ["'none'"],
    'script-src': ["'unsafe-inline'", "'unsafe-eval'", ...VIZ_SCRIPT_HOSTS],
    'style-src': ["'unsafe-inline'", ...VIZ_SCRIPT_HOSTS],
    'img-src': ['data:', 'blob:'],
    'font-src': ['data:', ...VIZ_SCRIPT_HOSTS],
    'connect-src': ["'none'"],
    'worker-src': ['blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'self'"],
  });
}
