// FRACTAL: implements F1 | component C9
import path from 'node:path';
import type { ModuleId, TopicId } from '@/shapes';
import { isContained, paths } from '@/core/paths';
import { err } from '@/core/errors';

/**
 * WHY (H14): the id pattern guarantees structure, never a location. Every id that
 * reaches the filesystem is resolved first and asserted inside C0's topics root; a
 * resolution that escapes is refused rather than repaired.
 */
export function topicDir(dataRoot: string, topicId: TopicId): string {
  const root = paths(dataRoot).topicsDir;
  const resolved = path.resolve(root, topicId);
  if (!isContained(root, resolved)) {
    throw err('sandbox-violation', { detail: 'topic id resolved outside the topics root' });
  }
  return resolved;
}

export function moduleDir(dataRoot: string, topicId: TopicId, moduleId: ModuleId): string {
  const root = paths(dataRoot).topicsDir;
  const resolved = paths(dataRoot).moduleDir(topicId, moduleId);
  if (!isContained(root, resolved)) {
    throw err('sandbox-violation', { detail: 'module id resolved outside the topics root' });
  }
  return resolved;
}

/**
 * The material the learner brought, beside their module directories and under the same
 * rule. It is the largest piece of learner data the app holds and the only one that
 * arrived as a file, so it is confined exactly as the authored content is — no wider.
 */
export function sourceDir(dataRoot: string, topicId: TopicId): string {
  const root = paths(dataRoot).topicsDir;
  const resolved = paths(dataRoot).sourceDir(topicId);
  if (!isContained(root, resolved)) {
    throw err('sandbox-violation', { detail: 'topic id resolved outside the topics root' });
  }
  return resolved;
}
