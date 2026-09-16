// FRACTAL: covers F1 | type integration
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigCache } from '@/core/config';
import { resetServices } from '@/api/services';
import { resetTokenCache, sessionToken } from '@/api/token';
import { allowedHosts, allowedOrigins } from '@/api/auth';

const APP_API = path.resolve(process.cwd(), 'app', 'api');
const METHODS = ['GET', 'POST', 'PATCH', 'DELETE', 'PUT'] as const;

type RouteFile = { file: string; urlPath: string; params: Record<string, string> };

const PARAM_VALUES: Record<string, string> = {
  id: 't_9fQ2xK4mZa71bC0d',
  topicId: 't_9fQ2xK4mZa71bC0d',
  moduleId: 'm_71bC0d9fQ2xK4mZa',
  sessionId: 's_4mZa71bC0d9fQ2xK',
};

function collectRoutes(dir: string, segments: string[] = []): RouteFile[] {
  const out: RouteFile[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectRoutes(full, [...segments, entry]));
      continue;
    }
    if (entry !== 'route.ts') continue;
    const params: Record<string, string> = {};
    const urlSegments = segments.map((s) => {
      const dynamic = /^\[(.+)\]$/.exec(s);
      if (dynamic === null) return s;
      const name = dynamic[1];
      const value = PARAM_VALUES[name] ?? 'x';
      params[name] = value;
      return value;
    });
    out.push({ file: full, urlPath: `/api/${urlSegments.join('/')}`, params });
  }
  return out;
}

function request(urlPath: string, method: string, headers: Record<string, string>): Request {
  const port = loadConfig().port;
  return new Request(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers },
    body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
  });
}

function logLines(dataRoot: string): Record<string, unknown>[] {
  const dir = path.join(path.resolve(dataRoot), 'logs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) =>
    readFileSync(path.join(dir, f), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>),
  );
}

describe('every route is authenticated', () => {
  let dataRoot: string;
  const routes = collectRoutes(APP_API);
  const handlers: { label: string; method: string; fn: (req: Request, ctx: unknown) => Promise<Response>; route: RouteFile }[] = [];

  beforeAll(async () => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-api-auth-'));
    process.env.LA_DATA_ROOT = dataRoot;
    resetConfigCache();
    resetTokenCache();
    resetServices();
    for (const route of routes) {
      const mod = (await import(pathToFileURL(route.file).href)) as Record<string, unknown>;
      for (const method of METHODS) {
        const fn = mod[method];
        if (typeof fn === 'function') {
          handlers.push({
            label: `${method} ${route.urlPath}`,
            method,
            fn: fn as (req: Request, ctx: unknown) => Promise<Response>,
            route,
          });
        }
      }
    }
  });

  afterAll(() => {
    resetServices();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('enumerates the routes that exist on disk', () => {
    expect(routes.length).toBeGreaterThan(15);
    expect(handlers.length).toBeGreaterThanOrEqual(routes.length);
  });

  it('rejects every route when no token is presented', async () => {
    for (const h of handlers) {
      const res = await h.fn(request(h.route.urlPath, h.method, {}), { params: Promise.resolve(h.route.params) });
      expect(res.status, h.label).toBe(401);
      const body = (await res.json()) as { ok: boolean; error: { code: string } };
      expect(body.ok, h.label).toBe(false);
      expect(body.error.code, h.label).toBe('unauthorized');
    }
  });

  it('rejects every route when the token is wrong', async () => {
    const wrong = 'f'.repeat(64);
    for (const h of handlers) {
      const res = await h.fn(request(h.route.urlPath, h.method, { 'x-la-token': wrong }), {
        params: Promise.resolve(h.route.params),
      });
      expect(res.status, h.label).toBe(401);
    }
  });

  it('rejects every route when the Origin is foreign', async () => {
    for (const h of handlers) {
      const res = await h.fn(
        request(h.route.urlPath, h.method, { 'x-la-token': sessionToken(), origin: 'https://evil.example' }),
        { params: Promise.resolve(h.route.params) },
      );
      expect(res.status, h.label).toBe(401);
    }
  });

  it('rejects a cross-site fetch even from an allowed origin string', async () => {
    const h = handlers[0];
    const res = await h.fn(
      request(h.route.urlPath, h.method, {
        'x-la-token': sessionToken(),
        origin: allowedOrigins()[0],
        'sec-fetch-site': 'cross-site',
      }),
      { params: Promise.resolve(h.route.params) },
    );
    expect(res.status).toBe(401);
  });

  it('rejects a request whose Host is not the configured origin', async () => {
    const h = handlers[0];
    const req = new Request(`http://evil.example/api/health`, {
      method: h.method,
      headers: { host: 'evil.example', 'x-la-token': sessionToken() },
    });
    const res = await h.fn(req, { params: Promise.resolve(h.route.params) });
    expect(res.status).toBe(401);
  });

  it('names the mismatch in the log and points a mismatched port at the port, not at reloading', async () => {
    // A container published as -p 8080:31544, or any reverse proxy: healthy server, right host,
    // wrong port in Host. Still refused, but diagnosably so.
    const port = loadConfig().port;
    const received = `localhost:${port + 1}`;
    const mod = (await import(pathToFileURL(path.join(APP_API, 'health', 'route.ts')).href)) as {
      GET: (req: Request, ctx: unknown) => Promise<Response>;
    };
    const before = logLines(dataRoot).length;
    const res = await mod.GET(
      new Request(`http://${received}/api/health`, {
        method: 'GET',
        headers: { host: received, 'x-la-token': sessionToken() },
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(401);

    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('unauthorized');
    expect(body.error.message).not.toBe('This page lost its connection to the app. Reload it to continue.');
    expect(body.error.message).toMatch(/port/i);
    // The expected host:port is a server-side detail; the caller is never told it.
    expect(body.error.message).not.toContain(String(port));

    const entry = logLines(dataRoot)
      .slice(before)
      .find((l) => l.event === 'api.host_rejected');
    expect(entry, 'a warn-level api.host_rejected entry').toBeDefined();
    expect(entry?.level).toBe('warn');
    expect(entry?.receivedHost).toBe(received);
    expect(entry?.expectedHosts).toEqual(allowedHosts());
    expect(allowedHosts()).toContain(`localhost:${port}`);
  });

  it('admits the app itself, with the token and its own origin', async () => {
    const mod = (await import(pathToFileURL(path.join(APP_API, 'health', 'route.ts')).href)) as {
      GET: (req: Request, ctx: unknown) => Promise<Response>;
    };
    const res = await mod.GET(
      request('/api/health', 'GET', { 'x-la-token': sessionToken(), origin: allowedOrigins()[0] }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);
  });

  it('sets the security headers on an authenticated and an unauthenticated response', async () => {
    const mod = (await import(pathToFileURL(path.join(APP_API, 'health', 'route.ts')).href)) as {
      GET: (req: Request, ctx: unknown) => Promise<Response>;
    };
    const headerSets: Record<string, string>[] = [{}, { 'x-la-token': sessionToken() }];
    for (const headers of headerSets) {
      const res = await mod.GET(request('/api/health', 'GET', headers), { params: Promise.resolve({}) });
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain('unsafe-inline');
      expect(csp).not.toMatch(/https?:\/\//);
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });
});
