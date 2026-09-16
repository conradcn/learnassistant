// FRACTAL: implements F5, F1, F13 | component C1
import Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  chmodSync,
  openSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  copyFileSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import type { AppPaths } from '@/shapes';
import { paths } from '@/core/paths';
import { loadConfig } from '@/core/config';
import { err } from '@/core/errors';
import { log } from '@/core/log';
import { runMigrations, readRecordedVersion, HIGHEST_KNOWN_MIGRATION } from '@/store/migrations';
import { createTopicsRepo, type TopicsRepo } from '@/store/topics';
import { createModulesRepo, type ModulesRepo } from '@/store/modules';
import { createEvalsRepo, type EvalsRepo } from '@/store/evals';
import { createReviewsRepo, type ReviewsRepo } from '@/store/reviews';
import {
  createReflectionsRepo,
  createPredictionsRepo,
  createCalibrationRepo,
  type ReflectionsRepo,
  type PredictionsRepo,
  type CalibrationRepo,
} from '@/store/reflections';
import { createJobsRepo, type JobsRepo } from '@/store/jobs';
import { createSourcesRepo, type SourcesRepo } from '@/store/source';
import { createCardsRepo, type CardsRepo } from '@/store/cards';
import { createCompleteModule, type CompleteModuleFn } from '@/store/complete';

/**
 * One kept copy of the database, identified by the schema version of the data inside it.
 * `schemaVersion` is null for the legacy unversioned `learn.db.prev` written by installs
 * that predate stamped generations; such a file is always treated as the oldest.
 */
export type PreviousGeneration = {
  schemaVersion: number | null;
  fileName: string;
  filePath: string;
};

export type StoreHealth = {
  schemaVersion: number;
  highestKnownMigration: number;
  /** Kept snapshots, newest generation first. */
  prevGenerations: PreviousGeneration[];
  /** The generation `restoreFromPrevious` would restore, or null if there is none. */
  restorableGeneration: PreviousGeneration | null;
  degradedTopicCount: number;
};

export type Store = {
  topics: TopicsRepo;
  modules: ModulesRepo;
  evals: EvalsRepo;
  reviews: ReviewsRepo;
  reflections: ReflectionsRepo;
  predictions: PredictionsRepo;
  calibration: CalibrationRepo;
  jobs: JobsRepo;
  sources: SourcesRepo;
  cards: CardsRepo;
  completeModule: CompleteModuleFn;
  health: () => StoreHealth;
};

const singletons = new Map<string, Store>();
const rawDbs = new Map<string, Database.Database>();

function fsyncFile(filePath: string): void {
  const fd = openSync(filePath, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function renameOverwriting(from: string, to: string): void {
  if (existsSync(to)) unlinkSync(to);
  renameSync(from, to);
}

function fsyncDir(dirPath: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(dirPath, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function chmodOwnerReadWrite(filePath: string): void {
  if (process.platform === 'win32') return;
  chmodSync(filePath, 0o600);
}

const GENERATION_FILE_RE = /^learn\.db\.v(\d+)\.prev$/;

/**
 * How many generations survive an open. Two is the smallest number that keeps both the
 * newest good copy and the one taken immediately before the migration that produced it,
 * which is the pair recovery actually needs; older schema versions are dead weight.
 */
const KEEP_GENERATIONS = 2;

/**
 * Snapshots the database into the generation named for the schema version it currently
 * holds. Called before and after migrations: when a migration applied, the two calls
 * write different files and the pre-migration data survives; when none did, the second
 * call simply refreshes the same file.
 */
function snapshotPrevious(db: Database.Database, p: AppPaths): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  const dest = p.dbPrevForVersion(version);
  const tmp = `${dest}.tmp`;
  if (existsSync(tmp)) unlinkSync(tmp);
  db.prepare('VACUUM INTO ?').run(tmp);
  fsyncFile(tmp);
  chmodOwnerReadWrite(tmp);
  renameOverwriting(tmp, dest);
  fsyncDir(path.dirname(dest));
  chmodOwnerReadWrite(dest);
}

/** Kept snapshots under `root`, newest generation first. */
export function listPreviousGenerations(dataRoot?: string): PreviousGeneration[] {
  const p = paths(resolveRoot(dataRoot));
  let names: string[] = [];
  try {
    names = readdirSync(p.dataRoot);
  } catch {
    return [];
  }
  const found: PreviousGeneration[] = [];
  for (const name of names) {
    const m = GENERATION_FILE_RE.exec(name);
    if (m) {
      found.push({
        schemaVersion: Number(m[1]),
        fileName: name,
        filePath: path.join(p.dataRoot, name),
      });
    }
  }
  if (existsSync(p.dbPrev)) {
    found.push({ schemaVersion: null, fileName: path.basename(p.dbPrev), filePath: p.dbPrev });
  }
  return found.sort((a, b) => (b.schemaVersion ?? -1) - (a.schemaVersion ?? -1));
}

function pruneOldGenerations(dataRoot: string): void {
  for (const gen of listPreviousGenerations(dataRoot).slice(KEEP_GENERATIONS)) {
    try {
      unlinkSync(gen.filePath);
    } catch {
      // a generation we could not delete is a stale file, not a failed open
    }
  }
}

function resolveRoot(dataRoot?: string): string {
  return path.resolve(dataRoot ?? loadConfig().dataRoot);
}

function buildStore(db: Database.Database, p: AppPaths): Store {
  const topics = createTopicsRepo(db);
  const modules = createModulesRepo(db);
  const evals = createEvalsRepo(db);
  const reviews = createReviewsRepo(db);
  const reflections = createReflectionsRepo(db);
  const predictions = createPredictionsRepo(db);
  const calibration = createCalibrationRepo(db);
  const jobs = createJobsRepo(db);
  const sources = createSourcesRepo(db);
  const cards = createCardsRepo(db);
  const completeModule = createCompleteModule(db, modules, reviews);

  const health = (): StoreHealth => {
    const versionRow = db.pragma('user_version', { simple: true }) as number;
    const degradedCount = topics.list().filter((t) => 'degraded' in t && t.degraded).length;
    const generations = listPreviousGenerations(p.dataRoot);
    return {
      schemaVersion: versionRow,
      highestKnownMigration: HIGHEST_KNOWN_MIGRATION,
      prevGenerations: generations,
      restorableGeneration: generations[0] ?? null,
      degradedTopicCount: degradedCount,
    };
  };

  return {
    topics,
    modules,
    evals,
    reviews,
    reflections,
    predictions,
    calibration,
    jobs,
    sources,
    cards,
    completeModule,
    health,
  };
}

export function openStore(dataRoot?: string): Store {
  const root = resolveRoot(dataRoot);
  const existing = singletons.get(root);
  if (existing) return existing;

  const p = paths(root);
  mkdirSync(p.dataRoot, { recursive: true });

  const fileExisted = existsSync(p.dbFile);
  let db: Database.Database;
  try {
    db = new Database(p.dbFile);
  } catch (e) {
    throw err('store-corrupt', { detail: 'database file could not be opened', cause: e });
  }

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = FULL');
  } catch (e) {
    db.close();
    throw err('store-corrupt', { detail: 'pragmas could not be applied', cause: e });
  }

  if (fileExisted) {
    let check: unknown;
    try {
      check = db.pragma('integrity_check', { simple: true });
    } catch (e) {
      db.close();
      throw err('store-corrupt', { detail: 'integrity check threw', cause: e });
    }
    if (check !== 'ok') {
      db.close();
      throw err('store-corrupt', { detail: `integrity check failed: ${String(check)}` });
    }
  }

  chmodOwnerReadWrite(p.dbFile);

  if (fileExisted) {
    const recorded = readRecordedVersion(db);
    if (recorded > HIGHEST_KNOWN_MIGRATION) {
      db.close();
      throw err('store-schema-ahead', {
        detail: `recorded schema version ${recorded} exceeds highest known migration ${HIGHEST_KNOWN_MIGRATION}`,
      });
    }
  }

  // WHY this is fatal where the post-migration snapshot is not: migrating without this
  // copy is unrecoverable. v5 drops `review_items.ease` after reading it, so if a full
  // disk swallowed the snapshot the original values would exist nowhere afterwards.
  if (fileExisted) {
    try {
      snapshotPrevious(db, p);
    } catch (e) {
      db.close();
      throw err('store-corrupt', {
        detail: 'the pre-migration snapshot could not be written, so migrations were not run',
        cause: e,
      });
    }
  }

  let applied = 0;
  try {
    applied = runMigrations(db);
  } catch (e) {
    db.close();
    throw e;
  }

  // WHY conditional: with nothing migrated this snapshot rewrites the generation file the
  // pre-migration copy above just wrote, byte for byte — a full read and write of the whole
  // database on every process start for no new information. A freshly created file is skipped
  // too: the pre-migration branch never ran, and an empty database is not worth keeping.
  if (fileExisted && applied > 0) {
    try {
      snapshotPrevious(db, p);
    } catch (e) {
      log({ level: 'warn', event: 'store-snapshot-failed', detail: e instanceof Error ? e.message : String(e) });
    }
  }

  pruneOldGenerations(root);

  for (const f of [`${p.dbFile}-wal`, `${p.dbFile}-shm`]) {
    if (existsSync(f)) chmodOwnerReadWrite(f);
  }

  const store = buildStore(db, p);
  singletons.set(root, store);
  rawDbs.set(root, db);
  log({ level: 'info', event: 'store-opened', component: 'C1' });
  return store;
}

/**
 * Restores the newest kept generation over the primary database — the most recent good
 * copy, which is what a corrupt `learn.db` needs. Older generations are left in place:
 * a learner who needs pre-migration values reads them out of those files by hand.
 */
export function restoreFromPrevious(dataRoot?: string): void {
  const root = resolveRoot(dataRoot);
  closeStore(root);
  const p = paths(root);
  const generation = listPreviousGenerations(root)[0];
  if (!generation) {
    throw err('store-corrupt', { detail: 'no previous generation is available to restore' });
  }
  if (existsSync(p.dbFile)) {
    const corruptPath = `${p.dbFile}.corrupt-${Date.now()}`;
    renameSync(p.dbFile, corruptPath);
    log({ level: 'error', event: 'store-corrupt-preserved', component: 'C1' });
  }
  const tmp = `${p.dbFile}.tmp-restore`;
  copyFileSync(generation.filePath, tmp);
  fsyncFile(tmp);
  renameOverwriting(tmp, p.dbFile);
  fsyncDir(path.dirname(p.dbFile));
  chmodOwnerReadWrite(p.dbFile);
  log({ level: 'warn', event: 'store-restored-from-previous', component: 'C1' });
}

export function closeStore(dataRoot?: string): void {
  if (dataRoot === undefined) {
    for (const [root, db] of rawDbs) {
      try {
        db.close();
      } catch {
        // already closed
      }
      rawDbs.delete(root);
      singletons.delete(root);
    }
    return;
  }
  const root = resolveRoot(dataRoot);
  const db = rawDbs.get(root);
  if (db) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  rawDbs.delete(root);
  singletons.delete(root);
}
