// FRACTAL: covers (none) | type unit
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetConfigCache } from '@/core/config';
import { resetLogState, log, loggingDegraded } from '@/core/log';

describe('log sink egress', () => {
  let dir: string;
  let originalDataRoot: string | undefined;
  let stderrSpy: ReturnType<typeof spyOnStderr>;

  function spyOnStderr() {
    return vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'la-log-sink-'));
    originalDataRoot = process.env.LA_DATA_ROOT;
    process.env.LA_DATA_ROOT = dir;
    resetConfigCache();
    resetLogState();
    stderrSpy = spyOnStderr();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    if (originalDataRoot === undefined) delete process.env.LA_DATA_ROOT;
    else process.env.LA_DATA_ROOT = originalDataRoot;
    rmSync(dir, { recursive: true, force: true });
    resetConfigCache();
    resetLogState();
  });

  it('never emits the raw pii marker to the ndjson file or stderr, but does emit its redaction token', () => {
    const marker = 'UNIQUE-PII-MARKER-38217';
    log({ level: 'info', event: 'learner-note', component: 'test', note: marker });

    const logsDir = path.join(dir, 'logs');
    const files = readdirSync(logsDir);
    expect(files.length).toBeGreaterThan(0);
    const content = readFileSync(path.join(logsDir, files[0]), 'utf8');
    expect(content).not.toContain(marker);
    expect(content).toMatch(/\[REDACTED:pii:[0-9a-f]{32}\]/);

    const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(stderrOutput).not.toContain(marker);
  });

  it('degrades to one stderr line and reports loggingDegraded without throwing when the log directory is unwritable', () => {
    const logsDirPath = path.join(dir, 'logs');
    writeFileSync(logsDirPath, 'this is a file, not a directory');

    expect(() => log({ level: 'info', event: 'first' })).not.toThrow();
    expect(() => log({ level: 'info', event: 'second' })).not.toThrow();

    const degradeLines = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('logging degraded'));
    expect(degradeLines.length).toBe(1);

    const status = loggingDegraded();
    expect(status.degraded).toBe(true);
    expect(status.reason).not.toBeNull();
  });
});
