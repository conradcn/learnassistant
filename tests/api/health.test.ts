// FRACTAL: covers F1 | type integration
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigCache } from '@/core/config';
import { resetServices } from '@/api/services';
import { resetTokenCache, sessionToken, tokenFilePath } from '@/api/token';
import { healthViewSchema, type HealthView } from '@/api/shapes';
import { GET as getHealth } from '../../app/api/health/route';

function req(): Request {
  const port = loadConfig().port;
  return new Request(`http://127.0.0.1:${port}/api/health`, {
    method: 'GET',
    headers: {
      host: `127.0.0.1:${port}`,
      'x-la-token': sessionToken(),
      origin: `http://127.0.0.1:${port}`,
    },
  });
}

const noParams = { params: Promise.resolve({}) };

describe('/api/health reveals no secret', () => {
  let dataRoot: string;
  let raw: string;
  let view: HealthView;

  beforeAll(async () => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-api-health-'));
    process.env.LA_DATA_ROOT = dataRoot;
    resetConfigCache();
    resetTokenCache();
    resetServices();
    const res = await getHealth(req(), noParams);
    expect(res.status).toBe(200);
    raw = await res.text();
    view = healthViewSchema.parse((JSON.parse(raw) as { data: unknown }).data);
  });

  afterAll(() => {
    resetServices();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('returns booleans, counts and versions', () => {
    expect(view.appVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(view.schemaVersion).toBeGreaterThan(0);
    expect(typeof view.cli.available).toBe('boolean');
    expect(view.degradedTopicCount).toBe(0);
  });

  it('never contains the per-launch token', () => {
    expect(raw).not.toContain(sessionToken());
    expect(raw).not.toContain('token');
  });

  it('never contains the data root path', () => {
    expect(raw).not.toContain(dataRoot);
    expect(raw).not.toContain(path.basename(dataRoot));
    expect(view.dataRootDigest).not.toContain(path.sep);
    expect(view.dataRootDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('writes the token file with owner-only permissions and never serves it', () => {
    const file = tokenFilePath(dataRoot);
    const onDisk = readFileSync(file, 'utf8').trim();
    expect(onDisk).toBe(sessionToken());
    expect(raw).not.toContain(onDisk);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });
});
