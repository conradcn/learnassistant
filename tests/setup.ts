// FRACTAL: implements (none) | component C0
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterAll } from 'vitest';
import { resetConfigCache } from '@/core/config';
import { resetLogState } from '@/core/log';
import { resetScrubSaltCache } from '@/core/scrub';

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'learn-assistant-test-'));
process.env.LA_DATA_ROOT = tempRoot;

beforeEach(() => {
  resetConfigCache();
  resetLogState();
  resetScrubSaltCache();
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});
