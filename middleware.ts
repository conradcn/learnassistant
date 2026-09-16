// FRACTAL: implements F1 | component C9
import { NextResponse, type NextRequest } from 'next/server';
import { documentCsp, newNonce } from '@/core/csp';

/**
 * WHY (H12): `next.config.mjs` headers are static, and a document CSP worth having needs a
 * per-response nonce — Next's App Router streams its payload through inline `<script>` tags,
 * and the only alternative to a nonce is `'unsafe-inline'`, which would let ANY inline script
 * run and so defend against nothing. Middleware is therefore where the document policy is
 * attached. Next reads the nonce back out of the request's own Content-Security-Policy header
 * and stamps its scripts with it, which is why the header is set on the request as well as
 * on the response.
 *
 * API routes are excluded: they set their own headers in src/api/respond.ts, from the same
 * policy module in @/core/csp, and they must not be handed a script nonce they have no use for.
 */
export function middleware(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const csp = documentCsp(nonce);

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

/**
 * WHY the Node runtime: nothing here needs the edge, and the app's process-level crash
 * handler is a Node-only module. Note that this declaration is not on its own enough to keep
 * the edge layer out of the picture — `next dev` builds an edge copy of `instrumentation.ts`
 * regardless, which is why that file is a runtime-guarded dispatcher rather than the handler
 * itself. See its WHY.
 */
export const runtime = 'nodejs';

export const config = {
  // Documents only. Files under /_next/static are immutable and served straight from disk;
  // running middleware over every one of them buys nothing and costs latency.
  matcher: ['/((?!api/|_next/static/|_next/image/|favicon.ico).*)'],
};
