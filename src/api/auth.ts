// FRACTAL: implements F1 | component C9
import { loadConfig } from '@/core/config';
import { log } from '@/core/log';
import { err, AppError } from '@/core/errors';
import { tokenMatches } from '@/api/token';

export { TOKEN_HEADER } from '@/shapes';
import { TOKEN_HEADER } from '@/shapes';

const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '[::1]'];

export function allowedOrigins(): string[] {
  const port = loadConfig().port;
  return LOOPBACK_HOSTS.map((h) => `http://${h}:${port}`);
}

export function allowedHosts(): string[] {
  const port = loadConfig().port;
  return LOOPBACK_HOSTS.map((h) => `${h}:${port}`);
}

/**
 * WHY (H12, deny by default): the allow condition is computed and everything else is
 * refused. A header that is absent is not a browser cross-site request, so it is allowed
 * to proceed to the token check, which is the actual credential; a header that is present
 * must match the one configured origin exactly.
 */
export function originAllowed(origin: string | null, fetchSite: string | null): boolean {
  if (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  if (origin === null) return true;
  return allowedOrigins().includes(origin);
}

export function hostAllowed(host: string | null): boolean {
  if (host === null) return false;
  return allowedHosts().includes(host);
}

function unauthorized(detail: string): AppError {
  return err('unauthorized', {
    detail,
    userMessage: 'This page lost its connection to the app. Reload it to continue.',
  });
}

/**
 * WHY a message of its own: a Host that does not match is almost never an attack — it is a
 * container published on a different port than the app is configured for, or a reverse proxy
 * that rewrites Host. The generic message sends that reader to reload forever. The expected
 * host:port is named only in the server log, never to the caller, so the response still says
 * nothing an untrusted caller could not already guess about the configuration.
 */
function hostMismatch(received: string | null): AppError {
  log({
    level: 'warn',
    event: 'api.host_rejected',
    component: 'C9',
    receivedHost: received === null ? null : received.slice(0, 120),
    expectedHosts: allowedHosts(),
  });
  return err('unauthorized', {
    detail: 'request host is not the configured origin',
    userMessage:
      'The app is reachable on a different port than it is configured for. Publish or proxy it on the same port the app runs on — see docs/TROUBLESHOOTING.md.',
  });
}

/**
 * Throws before any service is reached. The origin and token checks are indistinguishable from
 * each other in the response; only the host check — a misconfiguration, not a credential — says
 * so, and even then it names no expected value.
 */
export function authenticate(req: Request): void {
  const host = req.headers.get('host');
  if (!hostAllowed(host)) {
    throw hostMismatch(host);
  }
  if (!originAllowed(req.headers.get('origin'), req.headers.get('sec-fetch-site'))) {
    throw unauthorized('request origin is not on the allowlist');
  }
  if (!tokenMatches(req.headers.get(TOKEN_HEADER))) {
    throw unauthorized('request presented no valid per-launch token');
  }
}
