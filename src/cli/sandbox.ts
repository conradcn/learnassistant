// FRACTAL: implements F6 | component C2
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ModuleId, TopicId } from '@/shapes';
import { paths, isContained } from '@/core/paths';
import { loadConfig } from '@/core/config';
import { err } from '@/core/errors';

const MAX_REL_PATH_LEN = 512;

// WHY: confinement is checked on the resolved (realpath) result, never on the
// string alone — a symlink inside the module dir must not be able to point
// a read/write outside it, and a not-yet-existing target still needs its
// existing ancestor resolved so the check cannot be defeated by not-yet-created paths.
function resolveRealOrNearest(candidate: string): string {
  let cursor = path.resolve(candidate);
  const visited: string[] = [];
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    visited.push(cursor);
    cursor = parent;
  }
  const realBase = realpathSync(cursor);
  let result = realBase;
  for (let i = visited.length - 1; i >= 0; i -= 1) {
    result = path.join(result, path.basename(visited[i]));
  }
  return result;
}

function rejectMalformedRelPath(relPath: string): void {
  if (relPath.length === 0) {
    throw err('sandbox-violation', { detail: 'Empty relative path.' });
  }
  if (relPath.length > MAX_REL_PATH_LEN) {
    throw err('sandbox-violation', { detail: 'Relative path exceeds the maximum length.' });
  }
  if (path.isAbsolute(relPath)) {
    throw err('sandbox-violation', { detail: 'Absolute paths are not allowed inside the sandbox.' });
  }
  let decoded = relPath;
  for (let i = 0; i < 3; i += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  const segments = decoded.split(/[\\/]/);
  for (const segment of segments) {
    if (segment === '..') {
      throw err('sandbox-violation', { detail: 'Path traversal segment rejected.' });
    }
  }
  if (relPath.includes('\0')) {
    throw err('sandbox-violation', { detail: 'Null byte in path rejected.' });
  }
}

export class ModuleSandbox {
  readonly moduleDir: string;

  private constructor(moduleDir: string) {
    this.moduleDir = moduleDir;
  }

  static forModule(topicId: TopicId, moduleId: ModuleId): ModuleSandbox {
    const dataRoot = loadConfig().dataRoot;
    const moduleDir = paths(dataRoot).moduleDir(topicId, moduleId);
    mkdirSync(moduleDir, { recursive: true });
    const real = realpathSync(moduleDir);
    if (!isContained(paths(dataRoot).topicsDir, real)) {
      throw err('sandbox-violation', { detail: 'Module directory resolved outside topicsDir.' });
    }
    return new ModuleSandbox(real);
  }

  /**
   * A sandbox around a module directory the caller has already resolved.
   *
   * WHY it re-checks containment rather than trusting the caller: this is the boundary
   * that makes F6 true, and "the caller checked" is exactly the assumption that stops
   * being true the day a second caller appears. The check is cheap; the guarantee is not.
   */
  static forResolvedDir(moduleDir: string): ModuleSandbox {
    const dataRoot = loadConfig().dataRoot;
    const real = realpathSync(moduleDir);
    if (!isContained(paths(dataRoot).topicsDir, real)) {
      throw err('sandbox-violation', { detail: 'Module directory resolved outside topicsDir.' });
    }
    return new ModuleSandbox(real);
  }

  private resolveConfined(relPath: string): string {
    rejectMalformedRelPath(relPath);
    const joined = path.resolve(this.moduleDir, relPath);
    if (!isContained(this.moduleDir, joined)) {
      throw err('sandbox-violation', { detail: 'Resolved path escaped the module directory.' });
    }
    const real = resolveRealOrNearest(joined);
    if (!isContained(this.moduleDir, real)) {
      throw err('sandbox-violation', { detail: 'Resolved (real) path escaped the module directory.' });
    }
    return joined;
  }

  readFile(relPath: string): Buffer {
    const target = this.resolveConfined(relPath);
    return readFileSync(target);
  }

  writeFile(relPath: string, data: string | Buffer): void {
    const target = this.resolveConfined(relPath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
  }

  isPathContained(candidate: string): boolean {
    try {
      const real = resolveRealOrNearest(path.resolve(this.moduleDir, candidate));
      return isContained(this.moduleDir, real);
    } catch {
      return false;
    }
  }
}
