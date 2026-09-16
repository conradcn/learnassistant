// FRACTAL: implements (none) | component C0
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '@/core/config';
import { scrub } from '@/core/scrub';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogEntry = {
  level: LogLevel;
  event: string;
  component?: string;
  correlationId?: string;
  [k: string]: unknown;
};

let degraded = false;
let degradedReason: string | null = null;
let warnedOnce = false;
let cachedLogsDir: string | null = null;

function logsDir(): string {
  if (cachedLogsDir) return cachedLogsDir;
  const dataRoot = path.resolve(loadConfig().dataRoot);
  cachedLogsDir = path.join(dataRoot, 'logs');
  return cachedLogsDir;
}

function todayFileName(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `app-${y}-${m}-${d}.ndjson`;
}

export function log(entry: LogEntry): void {
  const scrubbed = scrub(entry) as LogEntry;
  const line = JSON.stringify(scrubbed);
  try {
    const dir = logsDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(path.join(dir, todayFileName()), `${line}\n`);
    process.stderr.write(`${scrubbed.level} ${scrubbed.event}\n`);
  } catch (e) {
    if (!warnedOnce) {
      warnedOnce = true;
      degraded = true;
      degradedReason = e instanceof Error ? e.message : 'log directory is unwritable';
      process.stderr.write(`logging degraded: ${degradedReason}\n`);
    }
  }
}

export function loggingDegraded(): { degraded: boolean; reason: string | null } {
  return { degraded, reason: degradedReason };
}

export function resetLogState(): void {
  degraded = false;
  degradedReason = null;
  warnedOnce = false;
  cachedLogsDir = null;
}
