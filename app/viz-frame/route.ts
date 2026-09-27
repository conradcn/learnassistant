// FRACTAL: implements F3 | component C10
import { vizFrameCsp } from '@/core/csp';
import { vizFrameDocument } from '@/ui/viz-frame';

/**
 * The host document an `interactive` lesson block runs in. WHY a route of its own rather
 * than a page: it must carry its own Content-Security-Policy (see `vizFrameCsp`), which is
 * why middleware.ts and next.config.mjs both leave this one path alone. It serves no data and
 * needs no credential — the lesson's code arrives by postMessage from the parent that framed it.
 */
export function GET(): Response {
  return new Response(vizFrameDocument(), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': vizFrameCsp(),
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    },
  });
}
