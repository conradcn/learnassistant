// FRACTAL: implements (none) | component C0
import { createHmac, randomBytes } from 'node:crypto';
import { openSync, writeSync, fsyncSync, closeSync, renameSync, existsSync, readFileSync, chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '@/core/config';

const STRUCTURAL_KEYS = new Set([
  'code',
  'correlationId',
  'kind',
  'status',
  'phase',
  'id',
  'topicId',
  'moduleId',
  'sessionId',
  // WHY exempt: it is a minted opaque id like the three above it, and it is the only
  // handle a log line has on WHICH piece of source material a line is about. The
  // material's own text — filename, extracted text, unit titles — is not exempt and is
  // hashed like every other piece of learner writing.
  'sourceId',
  'event',
  'component',
  'level',
  'mode',
  'op',
  'durMs',
  'at',
  // WHY exempt: this carries only schema field paths and zod issue codes — the NAMES of
  // the fields that failed, never the model's text. Scrubbing it hashed the one thing that
  // said which part of the lesson was wrong, leaving "content failed shape validation" as
  // the entire record of a session the learner had already paid for.
  'contractIssues',
  // WHY exempt: these are the app's own listening address and the Host header a request
  // arrived with — deployment configuration, never learner writing. Hashing them left
  // 'api.host_rejected' saying only that some host was refused, which is the one thing a
  // reader who has published the container on the wrong port already knows. The received
  // value is caller-controlled, so it is truncated before it is logged.
  'receivedHost',
  'expectedHosts',
]);

let cachedSalt: Buffer | null = null;

function fsyncDirBestEffort(dirPath: string): void {
  // Windows does not support fsync on a directory handle; skip there.
  if (process.platform === 'win32') return;
  const dirFd = openSync(dirPath, 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

function saltPathFor(dataRoot: string): string {
  return path.join(path.resolve(dataRoot), '.scrub-salt');
}

function mintSalt(saltPath: string): Buffer {
  const salt = randomBytes(16);
  // WHY: this is the first thing written under the data root, so on a genuine first run
  // — a fresh clone, or a data root the user pointed somewhere new — the directory does
  // not exist yet. Without this the salt write fails with ENOENT and every request
  // answers 500 before the app has done anything.
  mkdirSync(path.dirname(saltPath), { recursive: true, mode: 0o700 });
  const tmpPath = `${saltPath}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmpPath, 'w');
  try {
    writeSync(fd, salt);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, saltPath);
  fsyncDirBestEffort(path.dirname(saltPath));
  return salt;
}

function loadOrMintSalt(): Buffer {
  if (cachedSalt) return cachedSalt;
  const saltPath = saltPathFor(loadConfig().dataRoot);
  if (existsSync(saltPath)) {
    const existing = readFileSync(saltPath);
    if (existing.length === 16) {
      cachedSalt = existing;
      return cachedSalt;
    }
  }
  cachedSalt = mintSalt(saltPath);
  return cachedSalt;
}

function digest(text: string): string {
  const salt = loadOrMintSalt();
  return createHmac('sha256', salt).update(text, 'utf8').digest('hex').slice(0, 32);
}

function scrubString(s: string): string {
  return `[REDACTED:pii:${digest(s)}]`;
}

function scrubValue(value: unknown, key: string | null): unknown {
  if (key !== null && STRUCTURAL_KEYS.has(key)) {
    return value;
  }
  if (typeof value === 'string') {
    return scrubString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrubValue(v, null));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubValue(v, k);
    }
    return out;
  }
  return value;
}

export function scrub(value: unknown): unknown {
  return scrubValue(value, null);
}

export function resetScrubSaltCache(): void {
  cachedSalt = null;
}
