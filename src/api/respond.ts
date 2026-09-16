// FRACTAL: implements F1 | component C9
import type { ApiErr, ApiOk, ErrorCode } from '@/shapes';
import { toApiError } from '@/core/errors';
import { log } from '@/core/log';
import { authenticate } from '@/api/auth';
import { requireStore } from '@/api/services';
import { apiCsp } from '@/core/csp';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  validation: 400,
  'not-found': 404,
  conflict: 409,
  unauthorized: 401,
  'store-corrupt': 503,
  'store-key-missing': 404,
  'store-schema-ahead': 503,
  'cli-missing': 503,
  'cli-failed': 502,
  'sandbox-violation': 400,
  timeout: 504,
  cancelled: 499,
  internal: 500,
};

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  // WHY: the policy itself lives in @/core/csp, so the document CSP set by middleware.ts and
  // this API one cannot drift apart into two different ideas of what the app is allowed to do.
  'Content-Security-Policy': apiCsp(),
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

function withSecurityHeaders(headers: Headers): Headers {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return headers;
}

export function statusForCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

export function okResponse<T>(data: T, status = 200): Response {
  const body: ApiOk<T> = { ok: true, data };
  return new Response(JSON.stringify(body), {
    status,
    headers: withSecurityHeaders(new Headers({ 'Content-Type': 'application/json' })),
  });
}

/** WHY (H12): only the AppError shape crosses the wire — never a stack, a path, or the input. */
export function errorResponse(e: unknown): Response {
  const shape = toApiError(e);
  const body: ApiErr = { ok: false, error: shape };
  return new Response(JSON.stringify(body), {
    status: statusForCode(shape.code),
    headers: withSecurityHeaders(new Headers({ 'Content-Type': 'application/json' })),
  });
}

export function sseHeaders(): Headers {
  return withSecurityHeaders(
    new Headers({
      'Content-Type': 'text/event-stream',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    }),
  );
}

export type RouteContext<P> = { params: Promise<P> };

export type RouteOptions = { requiresStore?: boolean };

type Handler<P> = (req: Request, params: P) => Promise<unknown>;

function routeLabel(req: Request): string {
  try {
    return new URL(req.url).pathname;
  } catch {
    return 'unknown';
  }
}

/**
 * The single inbound funnel: authenticate, refuse when the store failed to open,
 * run exactly one service call, and wrap whatever comes back. Nothing else may
 * construct a Response for a JSON route.
 */
export function route<P = Record<string, never>>(
  handler: Handler<P>,
  options: RouteOptions = {},
): (req: Request, ctx: RouteContext<P>) => Promise<Response> {
  const requiresStore = options.requiresStore !== false;
  // WHY: Next 15's generated route types require the context parameter to be
  // non-optional, but a route with no dynamic segment is still called with one.
  return async (req: Request, ctx: RouteContext<P>): Promise<Response> => {
    const startedAt = Date.now();
    let response: Response;
    try {
      authenticate(req);
      if (requiresStore) requireStore();
      const params = ctx?.params === undefined ? ({} as P) : await ctx.params;
      response = okResponse(await handler(req, params));
    } catch (e) {
      response = errorResponse(e);
    }
    log({
      level: response.status >= 500 ? 'error' : 'info',
      event: 'http-request',
      component: 'C9',
      method: req.method,
      route: routeLabel(req),
      status: response.status,
      durMs: Date.now() - startedAt,
    });
    return response;
  };
}

/** Guard for streaming routes, which build their own Response body. */
export function guardStream(req: Request): Response | null {
  try {
    authenticate(req);
    requireStore();
    return null;
  } catch (e) {
    return errorResponse(e);
  }
}
