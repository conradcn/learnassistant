// FRACTAL: implements (none) | component C0
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { AppPaths, TopicId, ModuleId } from '@/shapes';
import { TOPIC_ID_RE, MODULE_ID_RE } from '@/shapes';
import { err } from '@/core/errors';

export function isContained(root: string, candidate: string): boolean {
  const normRoot = path.resolve(root);
  const normCandidate = path.resolve(candidate);
  const a = process.platform === 'win32' ? normRoot.toLowerCase() : normRoot;
  const b = process.platform === 'win32' ? normCandidate.toLowerCase() : normCandidate;
  if (a === b) return true;
  const rel = path.relative(a, b);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function paths(dataRoot: string): AppPaths {
  const resolvedRoot = path.resolve(dataRoot);
  const topicsDir = path.join(resolvedRoot, 'topics');
  const result: AppPaths = {
    dataRoot: resolvedRoot,
    dbFile: path.join(resolvedRoot, 'learn.db'),
    // The snapshot taken before the very first stamped generation existed. Installs made
    // before snapshots carried a schema version still have this file; nothing writes it now.
    dbPrev: path.join(resolvedRoot, 'learn.db.prev'),
    // WHY the version is in the name: a snapshot is only useful as the data it holds, and
    // the shape of that data is its schema version. One fixed path meant the post-migration
    // snapshot overwrote the pre-migration one, so a migration that drops a column (v5 drops
    // `review_items.ease`) left the original values in no file at all.
    dbPrevForVersion: (v: number): string => {
      if (!Number.isInteger(v) || v < 0) {
        throw err('validation', { detail: 'dbPrevForVersion called with a non-schema-version.' });
      }
      return path.join(resolvedRoot, `learn.db.v${v}.prev`);
    },
    logsDir: path.join(resolvedRoot, 'logs'),
    topicsDir,
    // WHY it is not under topics/: an upload is read before there is a subject to file it
    // under — the intake form needs the subject inferred from it first. Staging is the one
    // place a source file lives without a topic id, and it is confined in its own right.
    stagingDir: path.join(resolvedRoot, 'staging'),
    scrubSalt: path.join(resolvedRoot, '.scrub-salt'),
    sessionToken: randomBytes(16).toString('hex'),
    // WHY the same guard as moduleDir: the material the learner brought is learner data
    // sitting beside the module directories, so it is confined by the same rule — the id
    // pattern is checked, the join is resolved, and an escape is refused rather than fixed.
    sourceDir: (t: TopicId): string => {
      if (!TOPIC_ID_RE.test(t)) {
        throw err('validation', { detail: 'sourceDir called with a malformed topic id.' });
      }
      const resolved = path.resolve(topicsDir, t, 'source');
      if (!isContained(topicsDir, resolved)) {
        throw err('sandbox-violation', { detail: 'sourceDir resolved outside topicsDir.' });
      }
      return resolved;
    },
    moduleDir: (t: TopicId, m: ModuleId): string => {
      if (!TOPIC_ID_RE.test(t)) {
        throw err('validation', { detail: 'moduleDir called with a malformed topic id.' });
      }
      if (!MODULE_ID_RE.test(m)) {
        throw err('validation', { detail: 'moduleDir called with a malformed module id.' });
      }
      const resolved = path.resolve(topicsDir, t, 'modules', m);
      if (!isContained(topicsDir, resolved)) {
        throw err('sandbox-violation', { detail: 'moduleDir resolved outside topicsDir.' });
      }
      return resolved;
    },
  };
  return result;
}
