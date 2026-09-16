// FRACTAL: covers F1 | type integration
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigCache } from '@/core/config';
import { resetServices } from '@/api/services';
import { resetTokenCache, sessionToken } from '@/api/token';
import { recoveryInfoSchema, type RecoveryInfo } from '@/api/shapes';
import { GET as getRecoveryInfo } from '../../app/api/recovery/route';

function req(): Request {
  const port = loadConfig().port;
  return new Request(`http://127.0.0.1:${port}/api/recovery`, {
    method: 'GET',
    headers: {
      host: `127.0.0.1:${port}`,
      'x-la-token': sessionToken(),
      origin: `http://127.0.0.1:${port}`,
    },
  });
}

const noParams = { params: Promise.resolve({}) };

/**
 * WHY (H13): the recovery screen is the only surface allowed to name the data folder,
 * because a learner staring at a broken store has to be told where to look. This pins
 * both halves of that decision: the route serves the real names, in the declared shape.
 */
describe('/api/recovery names the files the learner has to find', () => {
  let dataRoot: string;
  let info: RecoveryInfo;

  beforeAll(async () => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-api-recovery-'));
    process.env.LA_DATA_ROOT = dataRoot;
    resetConfigCache();
    resetTokenCache();
    resetServices();
    const res = await getRecoveryInfo(req(), noParams);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown };
    info = recoveryInfoSchema.parse(body.data);
  });

  afterAll(() => {
    resetServices();
    rmSync(dataRoot, { recursive: true, force: true });
    delete process.env.LA_DATA_ROOT;
    resetConfigCache();
    resetTokenCache();
    resetServices();
  });

  it('conforms to the declared shape', () => {
    expect(recoveryInfoSchema.safeParse(info).success).toBe(true);
  });

  it('names the real data folder, not a digest of it', () => {
    expect(info.dataRoot).toBe(path.resolve(dataRoot));
    expect(info.dataRoot).toContain(path.sep);
  });

  it('names the backup file the learner is told to put back', () => {
    expect(info.dataFileName).toBe('learn.db');
    expect(info.backupFileName).toMatch(/^learn\.db\.v\d+\.prev$/);
  });
});
