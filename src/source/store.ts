// FRACTAL: implements F1 | component C11
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  SOURCE_ID_RE,
  sourceIdSchema,
  sourceKindSchema,
  sourceUnitSchema,
  type SourceId,
  type SourceKind,
  type SourceUnit,
  type TopicId,
} from '@/shapes';
import { isContained, paths } from '@/core/paths';
import { err } from '@/core/errors';
import { log } from '@/core/log';
import { safeFilename } from '@/source/text';

/** The extracted text of one document. Everything downstream reads this, not the upload. */
const TEXT_SUFFIX = '.txt';
const META_FILE = 'meta.json';
const STAGED_TEXT = 'text.txt';
const STAGED_ORIGINAL = 'original.bin';

/**
 * How long an upload may sit in staging without a topic claiming it.
 *
 * WHY it is swept at all: staging is the one place a file lives with no topic to own it,
 * so nothing else would ever delete it. A learner who uploads a textbook and then closes
 * the tab has left 25 MB of their own reading behind in a directory no screen shows them.
 */
export const STAGING_TTL_MS = 24 * 60 * 60 * 1000;

export const stagedMetaSchema = z.object({
  // The branded id, not a bare pattern: this record IS what gets written under the topic,
  // so a meta that only looked like a SourceId would need a cast at every use.
  id: sourceIdSchema,
  filename: z.string().max(300),
  kind: sourceKindSchema,
  byteSize: z.number().int().min(0),
  charCount: z.number().int().min(0),
  pageCount: z.number().int().min(0).nullable(),
  truncated: z.boolean(),
  units: z.array(sourceUnitSchema),
});
export type StagedMeta = z.infer<typeof stagedMetaSchema>;

function fsyncPath(target: string, flags: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(target, flags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function chmodQuiet(target: string, mode: number): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(target, mode);
  } catch {
    // A filesystem that will not take a mode is not a reason to lose the learner's upload.
  }
}

/** Temp -> fsync -> rename -> fsync dir, the same protocol content.json is written with. */
function writeDurable(dir: string, name: string, bytes: Buffer): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodQuiet(dir, 0o700);
  const finalPath = path.join(dir, name);
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, bytes, { mode: 0o600 });
  chmodQuiet(tmpPath, 0o600);
  fsyncPath(tmpPath, 'r+');
  renameSync(tmpPath, finalPath);
  fsyncPath(dir, 'r');
  chmodQuiet(finalPath, 0o600);
  return finalPath;
}

/**
 * WHY the id is re-checked here and not only at the route: this is the last function
 * before a learner-supplied id becomes a path, and C0's rule is that a shape guarantees
 * structure and never a location. The pattern is asserted, the join is resolved, and a
 * result outside the staging root is refused rather than repaired.
 */
export function stagedDir(dataRoot: string, sourceId: string): string {
  if (!SOURCE_ID_RE.test(sourceId)) {
    throw err('validation', { detail: 'stagedDir called with a malformed source id.' });
  }
  const root = paths(dataRoot).stagingDir;
  const resolved = path.resolve(root, sourceId);
  if (!isContained(root, resolved)) {
    throw err('sandbox-violation', { detail: 'source id resolved outside the staging root.' });
  }
  return resolved;
}

export type StagedRecord = { meta: StagedMeta; text: string; original: Buffer | null };

/**
 * Puts an extracted upload somewhere it can wait. Staging exists because the intake form
 * needs the SUBJECT inferred from the material before there is a topic to file it under —
 * the upload is read first and belongs to something second.
 */
export function stageSource(
  dataRoot: string,
  meta: StagedMeta,
  text: string,
  original: Uint8Array | null,
): void {
  const dir = stagedDir(dataRoot, meta.id);
  writeDurable(dir, STAGED_TEXT, Buffer.from(text, 'utf8'));
  if (original !== null) writeDurable(dir, STAGED_ORIGINAL, Buffer.from(original));
  writeDurable(dir, META_FILE, Buffer.from(JSON.stringify(stagedMetaSchema.parse(meta)), 'utf8'));
}

export function readStaged(dataRoot: string, sourceId: SourceId): StagedRecord | null {
  const dir = stagedDir(dataRoot, sourceId);
  const metaPath = path.join(dir, META_FILE);
  if (!existsSync(metaPath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
  const parsed = stagedMetaSchema.safeParse(raw);
  if (!parsed.success || parsed.data.id !== sourceId) return null;
  const textPath = path.join(dir, STAGED_TEXT);
  if (!existsSync(textPath)) return null;
  const originalPath = path.join(dir, STAGED_ORIGINAL);
  return {
    meta: parsed.data,
    text: readFileSync(textPath, 'utf8'),
    original: existsSync(originalPath) ? readFileSync(originalPath) : null,
  };
}

export function discardStaged(dataRoot: string, sourceId: SourceId): void {
  rmSync(stagedDir(dataRoot, sourceId), { recursive: true, force: true });
}

/** Removes every staged upload older than the TTL. Returns how many it removed. */
export function sweepStaging(dataRoot: string, ttlMs: number = STAGING_TTL_MS, now: number = Date.now()): number {
  const root = paths(dataRoot).stagingDir;
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const entry of readdirSync(root)) {
    if (!SOURCE_ID_RE.test(entry)) continue;
    const dir = path.join(root, entry);
    try {
      if (now - statSync(dir).mtimeMs < ttlMs) continue;
      rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // A directory that vanished under us, or one we cannot stat, is not this sweep's
      // problem — the next one will find it if it is still there.
    }
  }
  if (removed > 0) log({ level: 'info', event: 'source-staging-swept', component: 'C11', removed });
  return removed;
}

function textFileFor(dataRoot: string, topicId: TopicId, sourceId: SourceId): string {
  if (!SOURCE_ID_RE.test(sourceId)) {
    throw err('validation', { detail: 'source text path requested for a malformed source id.' });
  }
  const dir = paths(dataRoot).sourceDir(topicId);
  const resolved = path.resolve(dir, `${sourceId}${TEXT_SUFFIX}`);
  if (!isContained(dir, resolved)) {
    throw err('sandbox-violation', { detail: 'source text resolved outside the topic source directory.' });
  }
  return resolved;
}

export type StoredSource = {
  id: SourceId;
  filename: string;
  kind: SourceKind;
  byteSize: number;
  charCount: number;
  pageCount: number | null;
  truncated: boolean;
  units: SourceUnit[];
};

/**
 * Puts one document under `<dataRoot>/topics/<topic>/source/`, beside the module
 * directories and under the same path confinement.
 *
 * The upload is kept as well as the text: extraction is lossy and improvable, and a
 * learner who is told "we could not read your book" should not also have lost it.
 */
export function writeSourceDocument(
  dataRoot: string,
  topicId: TopicId,
  record: StoredSource,
  text: string,
  original: Uint8Array | null,
): void {
  const dir = paths(dataRoot).sourceDir(topicId);
  writeDurable(dir, `${record.id}${TEXT_SUFFIX}`, Buffer.from(text, 'utf8'));
  if (original !== null) {
    // The learner's own name for the file, stripped of anything that is not plainly part
    // of a name, so the folder is browsable and the join is still a single segment.
    writeDurable(dir, `${record.id}-${safeFilename(record.filename)}`, Buffer.from(original));
  }
}

/** The extracted text of one document, or null when it is not on disk. */
export function readSourceText(dataRoot: string, topicId: TopicId, sourceId: SourceId): string | null {
  const file = textFileFor(dataRoot, topicId, sourceId);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    log({ level: 'warn', event: 'source-text-unreadable', component: 'C11', topicId, sourceId });
    return null;
  }
}
