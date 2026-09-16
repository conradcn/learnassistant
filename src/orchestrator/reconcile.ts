// FRACTAL: implements F2 | component C4
import { createHash } from 'node:crypto';
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
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  MODULE_ID_RE,
  moduleIdSchema,
  type ModuleContent,
  type ModuleGraph,
  type ModuleId,
  type ModuleNode,
  type TopicId,
} from '@/shapes';
import { paths, isContained } from '@/core/paths';
import { err } from '@/core/errors';
import { log } from '@/core/log';
import type { Store } from '@/store/open';
import { TopicDeletedError } from '@/orchestrator/topic-state';
import {
  CONTENT_VERSION,
  MAX_CONTENT_BYTES,
  loadEnvelope,
  type ContentEnvelope,
  type ContentLoad,
} from '@/orchestrator/content-validate';

export const CONTENT_FILE = 'content.json';

/** The one degraded reason that means "nothing has gone wrong yet, the writing session
 *  simply has not run". C9 reads it to tell an unwritten lesson from a broken one. */
export const NEVER_WRITTEN_REASON = 'This lesson has not been written yet.';

export function contentDigest(content: ModuleContent): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

// WHY: the resolved path is asserted contained after resolution, not merely
// pattern-checked before the join — a shape guarantees structure, never value.
export function moduleDirFor(dataRoot: string, topicId: TopicId, moduleId: ModuleId): string {
  const p = paths(dataRoot);
  const resolved = path.resolve(p.moduleDir(topicId, moduleId));
  if (!isContained(p.topicsDir, resolved)) {
    throw err('sandbox-violation', { detail: 'module directory resolved outside the topics root' });
  }
  return resolved;
}

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
  chmodSync(target, mode);
}

export function ensureModuleDir(dataRoot: string, topicId: TopicId, moduleId: ModuleId): string {
  const dir = moduleDirFor(dataRoot, topicId, moduleId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodQuiet(dir, 0o700);
  return dir;
}

export type CommitHooks = { afterFileBeforeRow?: () => void };

export function writeContentFile(
  dataRoot: string,
  topicId: TopicId,
  moduleId: ModuleId,
  content: ModuleContent,
): string {
  const dir = ensureModuleDir(dataRoot, topicId, moduleId);
  const finalPath = path.join(dir, CONTENT_FILE);
  const tmpPath = path.join(dir, `${CONTENT_FILE}.tmp`);
  const prevPath = path.join(dir, `${CONTENT_FILE}.prev`);
  const digest = contentDigest(content);
  const envelope: ContentEnvelope = { contentVersion: CONTENT_VERSION, digest, content };
  const bytes = Buffer.from(JSON.stringify(envelope), 'utf8');
  if (bytes.byteLength > MAX_CONTENT_BYTES) {
    throw err('validation', { detail: 'authored module content exceeded the 1 MB cap' });
  }
  writeFileSync(tmpPath, bytes, { mode: 0o600 });
  chmodQuiet(tmpPath, 0o600);
  fsyncPath(tmpPath, 'r+');
  if (existsSync(finalPath)) {
    if (existsSync(prevPath)) unlinkSync(prevPath);
    renameSync(finalPath, prevPath);
  }
  renameSync(tmpPath, finalPath);
  fsyncPath(dir, 'r');
  chmodQuiet(finalPath, 0o600);
  return digest;
}

export function readContentFile(dataRoot: string, topicId: TopicId, moduleId: ModuleId): ContentLoad {
  const filePath = path.join(moduleDirFor(dataRoot, topicId, moduleId), CONTENT_FILE);
  if (!existsSync(filePath)) {
    return { ok: false, degradedReason: NEVER_WRITTEN_REASON };
  }
  if (statSync(filePath).size > MAX_CONTENT_BYTES) {
    return { ok: false, degradedReason: 'This lesson file is too large to open safely.' };
  }
  return loadEnvelope(readFileSync(filePath), contentDigest);
}

// WHY (H4): content.json lands FIRST and the module row lands SECOND, because
// the loader keys discovery on the row. An interruption in the gap therefore
// leaves an orphan directory the sweep can rebuild, never a row whose content
// the reader silently skips.
export function commitModule(
  store: Store,
  dataRoot: string,
  node: ModuleNode,
  content: ModuleContent,
  hooks?: CommitHooks,
): ModuleNode {
  // WHY before the file and not left to the row: `module_nodes.topic_id` references
  // `topics(id)`, so a subject deleted mid-run made this write a lesson to disk and then
  // fail on the foreign key — an orphan lesson for a subject that is gone, and a failure
  // report for a deletion that worked. Finding out first means nothing is written at all.
  if (store.topics.get(node.topicId) === null) throw new TopicDeletedError(node.topicId);
  writeContentFile(dataRoot, node.topicId, node.id, content);
  if (hooks?.afterFileBeforeRow) hooks.afterFileBeforeRow();
  const committed: ModuleNode = { ...node, content };
  // WHY one row and not the whole graph: module tasks for the same topic run concurrently,
  // so a read-splice-rewrite here would have the later writer put back the stale copy of a
  // sibling the earlier writer had already committed — a module reported complete rendering
  // empty. Edges and entry modules are untouched by a commit, so nothing else needs writing.
  store.modules.upsertNode(committed);
  return committed;
}

export type SweepOutcome = {
  rebuiltFromDisk: ModuleId[];
  orphanDirectories: ModuleId[];
  missingContent: ModuleId[];
  degraded: { moduleId: ModuleId; reason: string }[];
};

function moduleIdsOnDisk(dataRoot: string, topicId: TopicId): ModuleId[] {
  const modulesRoot = path.join(paths(dataRoot).topicsDir, topicId, 'modules');
  if (!existsSync(modulesRoot)) return [];
  return readdirSync(modulesRoot)
    .filter((name) => MODULE_ID_RE.test(name))
    .map((name) => moduleIdSchema.parse(name));
}

// WHY: a directory with no row is invisible to every reader, so the sweep is
// what turns an interrupted commit back into a module — but only when the
// digest validates, so a half-written file is never promoted.
export function reconcileTopic(store: Store, dataRoot: string, topicId: TopicId): SweepOutcome {
  const outcome: SweepOutcome = {
    rebuiltFromDisk: [],
    orphanDirectories: [],
    missingContent: [],
    degraded: [],
  };
  const graph: ModuleGraph = store.modules.graph(topicId);
  const rowIds = new Set<ModuleId>(graph.nodes.map((n) => n.id));

  for (const node of graph.nodes) {
    if (node.content === null) continue;
    const load = readContentFile(dataRoot, node.topicId, node.id);
    if (load.ok) continue;
    outcome.missingContent.push(node.id);
    outcome.degraded.push({ moduleId: node.id, reason: load.degradedReason });
  }

  // WHY authorable-only: ordinals are handed out over the modules alone — the capstone
  // takes `modules + 1` — so counting every node here put a rebuilt module on the
  // capstone's number whenever a row went missing.
  const authorableCount = graph.nodes.filter((n) => n.kind !== 'capstone').length;
  const rebuilt: ModuleNode[] = [];
  for (const moduleId of moduleIdsOnDisk(dataRoot, topicId)) {
    if (rowIds.has(moduleId)) continue;
    outcome.orphanDirectories.push(moduleId);
    const load = readContentFile(dataRoot, topicId, moduleId);
    if (!load.ok) {
      outcome.degraded.push({ moduleId, reason: load.degradedReason });
      continue;
    }
    rebuilt.push({
      id: moduleId,
      topicId,
      title: load.content.learningGoals[0] ?? 'Recovered lesson',
      ordinal: authorableCount + rebuilt.length + 1,
      kind: 'module',
      testOutEligible: false,
      estimatedMinutes: 20,
      state: 'available',
      content: load.content,
    });
    outcome.rebuiltFromDisk.push(moduleId);
  }

  if (rebuilt.length > 0) {
    store.modules.upsertGraph({ ...graph, nodes: [...graph.nodes, ...rebuilt] });
  }
  log({
    level: 'info',
    event: 'orchestrator-reconciled',
    component: 'C4',
    topicId,
    rebuilt: outcome.rebuiltFromDisk.length,
    orphans: outcome.orphanDirectories.length,
  });
  return outcome;
}

export function discardOrphanDirectory(dataRoot: string, topicId: TopicId, moduleId: ModuleId): void {
  const dir = moduleDirFor(dataRoot, topicId, moduleId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

export const IN_FLIGHT_FILE = 'in-flight-jobs.json';

function inFlightPath(dataRoot: string): string {
  return path.join(paths(dataRoot).dataRoot, IN_FLIGHT_FILE);
}

// WHY: C1's jobs repo exposes no "list running" query, so the orchestrator
// keeps its own durable index of the job ids it marked running. It is written
// just after `claimNext` has committed the flip to running and cleared once the
// row is finished, so it is a hint and not a record: a crash in the window
// between the claim and the write leaves a running job that the index never
// names. Recovery therefore requeues from the jobs table — the one thing written
// inside the claim transaction — and uses the index only to know what to clear.
export function readInFlightIndex(dataRoot: string): string[] {
  const file = inFlightPath(dataRoot);
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && /^j_[0-9a-f]{16}$/.test(v));
  } catch {
    return [];
  }
}

export function writeInFlightIndex(dataRoot: string, ids: string[]): void {
  const root = paths(dataRoot).dataRoot;
  mkdirSync(root, { recursive: true });
  const file = inFlightPath(dataRoot);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(ids), { mode: 0o600 });
  chmodQuiet(tmp, 0o600);
  fsyncPath(tmp, 'r+');
  renameSync(tmp, file);
  fsyncPath(root, 'r');
}
