// FRACTAL: covers F1 | type integration
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigCache } from '@/core/config';
import { paths } from '@/core/paths';
import { closeStore, openStore, listPreviousGenerations } from '@/store/open';
import { resetServices } from '@/api/services';
import { resetTokenCache, sessionToken } from '@/api/token';
import { healthViewSchema } from '@/api/shapes';
import { GET as getHealth } from '../../app/api/health/route';
import { POST as postRecovery } from '../../app/api/recovery/route';
import { GET as getTopics } from '../../app/api/topics/route';

const APP_API = path.resolve(process.cwd(), 'app', 'api');
const METHODS = ['GET', 'POST', 'PATCH', 'DELETE'] as const;
const STORE_OPTIONAL = new Set(['/api/health', '/api/recovery']);

const PARAM_VALUES: Record<string, string> = {
  id: 't_9fQ2xK4mZa71bC0d',
  topicId: 't_9fQ2xK4mZa71bC0d',
  moduleId: 'm_71bC0d9fQ2xK4mZa',
  sessionId: 's_4mZa71bC0d9fQ2xK',
};

type RouteFile = { file: string; urlPath: string; params: Record<string, string> };

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
      params[dynamic[1]] = PARAM_VALUES[dynamic[1]] ?? 'x';
      return params[dynamic[1]];
    });
    out.push({ file: full, urlPath: `/api/${urlSegments.join('/')}`, params });
  }
  return out;
}

function req(urlPath: string, method: string, body?: unknown): Request {
  const port = loadConfig().port;
  return new Request(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      host: `127.0.0.1:${port}`,
      'content-type': 'application/json',
      'x-la-token': sessionToken(),
      origin: `http://127.0.0.1:${port}`,
    },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}),
  });
}

const noParams = { params: Promise.resolve({}) };

describe('a store that failed to open is an error everywhere, never an empty state', () => {
  let dataRoot: string;

  beforeAll(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-api-storedown-'));
    process.env.LA_DATA_ROOT = dataRoot;
    resetConfigCache();
    resetTokenCache();
    resetServices();

    const store = openStore(dataRoot);
    store.topics.create({ subject: 'Information theory', level: 'intermediate', purpose: 'p', diagnostic: null });
    closeStore(dataRoot);
    openStore(dataRoot);
    closeStore(dataRoot);

    const p = paths(dataRoot);
    for (const sidecar of [`${p.dbFile}-wal`, `${p.dbFile}-shm`]) {
      if (existsSync(sidecar)) rmSync(sidecar, { force: true });
    }
    writeFileSync(p.dbFile, 'this is not a database at all, not even close');
    resetServices();
  });

  afterAll(() => {
    resetServices();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('keeps a previous generation to recover from', () => {
    expect(listPreviousGenerations(dataRoot).length).toBeGreaterThan(0);
  });

  it('answers 503 store-corrupt on every route that needs the store', async () => {
    const routes = collectRoutes(APP_API).filter((r) => !STORE_OPTIONAL.has(r.urlPath));
    expect(routes.length).toBeGreaterThan(10);
    for (const route of routes) {
      const mod = (await import(pathToFileURL(route.file).href)) as Record<string, unknown>;
      for (const method of METHODS) {
        const fn = mod[method];
        if (typeof fn !== 'function') continue;
        const res = await (fn as (r: Request, c: unknown) => Promise<Response>)(req(route.urlPath, method), {
          params: Promise.resolve(route.params),
        });
        const label = `${method} ${route.urlPath}`;
        expect(res.status, label).toBe(503);
        const body = (await res.json()) as { ok: boolean; error: { code: string } };
        expect(body.ok, label).toBe(false);
        expect(body.error.code, label).toBe('store-corrupt');
      }
    }
  });

  it('still serves health, and says the saved data could not be opened', async () => {
    const res = await getHealth(req('/api/health', 'GET'), noParams);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown };
    const view = healthViewSchema.parse(body.data);
    expect(view.configWarnings).toContain('Your saved data could not be opened.');
  });

  it('serves the use-previous-generation action without the broken store, and recovers', async () => {
    const res = await postRecovery(req('/api/recovery', 'POST'), noParams);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { restored: boolean } };
    expect(body.ok).toBe(true);
    expect(body.data.restored).toBe(true);

    const after = await getTopics(req('/api/topics', 'GET'), noParams);
    expect(after.status).toBe(200);
    const view = (await after.json()) as { data: { topics: unknown[] } };
    expect(view.data.topics.length).toBe(1);
  });
});
