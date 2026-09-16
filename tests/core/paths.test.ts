// FRACTAL: covers (none) | type unit
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { paths, isContained } from '@/core/paths';
import { AppError } from '@/core/errors';
import type { TopicId, ModuleId } from '@/shapes';

describe('paths().moduleDir', () => {
  const dataRoot = path.join(os.tmpdir(), 'la-paths-test-root');
  const p = paths(dataRoot);

  it('rejects a malformed TopicId before any join', () => {
    expect(() => p.moduleDir('not-a-topic' as TopicId, 'm_71bC0d9fQ2xK4mZa' as ModuleId)).toThrow(AppError);
  });

  it('rejects a malformed ModuleId before any join', () => {
    expect(() => p.moduleDir('t_9fQ2xK4mZa71bC0d' as TopicId, 'not-a-module' as ModuleId)).toThrow(AppError);
  });

  it('rejects an absolute path used as an id', () => {
    const absolute = os.platform() === 'win32' ? 'C:\\evil\\path' : '/etc/passwd';
    expect(() => p.moduleDir(absolute as TopicId, 'm_71bC0d9fQ2xK4mZa' as ModuleId)).toThrow(AppError);
  });

  it('rejects a ".." traversal attempt in an id', () => {
    expect(() => p.moduleDir('t_../../../../etc' as TopicId, 'm_71bC0d9fQ2xK4mZa' as ModuleId)).toThrow(AppError);
  });

  it('rejects a Windows-style drive-letter id', () => {
    expect(() => p.moduleDir('t_C:\\Windows\\System32' as TopicId, 'm_71bC0d9fQ2xK4mZa' as ModuleId)).toThrow(AppError);
  });

  it('accepts well-formed ids and returns a contained path', () => {
    const dir = p.moduleDir('t_9fQ2xK4mZa71bC0d' as TopicId, 'm_71bC0d9fQ2xK4mZa' as ModuleId);
    expect(isContained(p.topicsDir, dir)).toBe(true);
  });
});

describe('isContained', () => {
  it('returns false for a sibling directory whose name is a prefix of the root', () => {
    const root = path.join(os.tmpdir(), 'dataroot');
    const evilSibling = path.join(os.tmpdir(), 'dataroot-evil', 'x');
    expect(isContained(root, evilSibling)).toBe(false);
  });

  it('treats the root itself as contained', () => {
    const root = path.join(os.tmpdir(), 'dataroot2');
    expect(isContained(root, root)).toBe(true);
  });

  it('returns true for a genuine child path', () => {
    const root = path.join(os.tmpdir(), 'dataroot3');
    const child = path.join(root, 'a', 'b');
    expect(isContained(root, child)).toBe(true);
  });

  it('returns false for a parent directory', () => {
    const root = path.join(os.tmpdir(), 'dataroot4', 'child');
    const parent = path.join(os.tmpdir(), 'dataroot4');
    expect(isContained(root, parent)).toBe(false);
  });
});
