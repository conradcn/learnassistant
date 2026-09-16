// FRACTAL: implements F1 | component C9
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '@/core/config';
import { log } from '@/core/log';

const TOKEN_RE = /^[0-9a-f]{64}$/;

/**
 * WHY: Next bundles the layout and the route handlers separately, so a module-level
 * cache is not one cache — it is one per bundle. The credential has to be per *process*,
 * or one bundle mints a second token and silently invalidates the one already sitting in
 * the page the user is looking at. The slot is keyed on a global symbol so every bundle
 * in the process reads and writes the same one.
 */
type TokenSlot = { token: string; root: string };
const SLOT_KEY = Symbol.for('learn-assistant.session-token');
const slotHost = globalThis as typeof globalThis & { [SLOT_KEY]?: TokenSlot };

function readSlot(root: string): string | null {
  const slot = slotHost[SLOT_KEY];
  return slot !== undefined && slot.root === root ? slot.token : null;
}

function writeSlot(root: string, token: string): void {
  slotHost[SLOT_KEY] = { root, token };
}

export function tokenFilePath(dataRoot: string): string {
  return path.join(path.resolve(dataRoot), '.session-token');
}

function fsyncDirBestEffort(dirPath: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(dirPath, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeToken(filePath: string, token: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmpPath, 'w', 0o600);
  try {
    writeSync(fd, token);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (process.platform !== 'win32') chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, filePath);
  fsyncDirBestEffort(path.dirname(filePath));
  if (process.platform !== 'win32') chmodSync(filePath, 0o600);
}

/** Mints a fresh per-launch token and commits it before the caller may serve a request. */
export function mintSessionToken(dataRoot?: string): string {
  const root = path.resolve(dataRoot ?? loadConfig().dataRoot);
  const token = randomBytes(32).toString('hex');
  writeToken(tokenFilePath(root), token);
  writeSlot(root, token);
  log({ level: 'info', event: 'session-token-minted', component: 'C9', digest: tokenDigest(token) });
  return token;
}

/**
 * WHY (H12): the credential lives in memory for the life of the process. The file
 * is only a hand-off channel, so an unreadable or rotated file is recovered from by
 * minting a new token loudly rather than by trusting whatever is on disk.
 */
export function sessionToken(dataRoot?: string): string {
  const root = path.resolve(dataRoot ?? loadConfig().dataRoot);
  const live = readSlot(root);
  if (live !== null) return live;
  let onDisk: string | null = null;
  try {
    const raw = readFileSync(tokenFilePath(root), 'utf8').trim();
    onDisk = TOKEN_RE.test(raw) ? raw : null;
  } catch {
    onDisk = null;
  }
  if (onDisk === null) {
    log({ level: 'warn', event: 'session-token-unreadable', component: 'C9' });
    return mintSessionToken(root);
  }
  writeSlot(root, onDisk);
  return onDisk;
}

/**
 * Mints once per process and never again. Anything that only needs *a* valid token for
 * this launch calls this; only an explicit rotation calls `mintSessionToken`.
 */
export function ensureSessionToken(dataRoot?: string): string {
  const root = path.resolve(dataRoot ?? loadConfig().dataRoot);
  const live = readSlot(root);
  if (live !== null) return live;
  return mintSessionToken(root);
}

export function tokenMatches(presented: string | null): boolean {
  if (presented === null) return false;
  if (!TOKEN_RE.test(presented)) return false;
  const expected = Buffer.from(sessionToken(), 'utf8');
  const actual = Buffer.from(presented, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function tokenDigest(token: string): string {
  return createHmac('sha256', 'la-session-token-digest').update(token).digest('hex').slice(0, 16);
}

export function pathDigest(value: string): string {
  return createHmac('sha256', sessionToken()).update(path.resolve(value)).digest('hex').slice(0, 16);
}

export function resetTokenCache(): void {
  delete slotHost[SLOT_KEY];
}
