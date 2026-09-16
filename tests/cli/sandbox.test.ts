// FRACTAL: covers F6 | type unit
import { describe, it, expect } from 'vitest';
import { mkdtempSync, symlinkSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModuleSandbox } from '@/cli/sandbox';
import { resetConfigCache } from '@/core/config';
import { exampleTopicId, exampleModuleId } from '@/shapes';

function freshRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'la-sandbox-'));
  process.env.LA_DATA_ROOT = dir;
  resetConfigCache();
  return dir;
}

function canCreateSymlink(): boolean {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'la-symlink-probe-'));
  const target = path.join(dir, 'target.txt');
  const link = path.join(dir, 'link.txt');
  writeFileSync(target, 'x');
  try {
    symlinkSync(target, link);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SYMLINKS_SUPPORTED = canCreateSymlink();

describe('ModuleSandbox', () => {
  it('allows writes and reads within the module directory', () => {
    freshRoot();
    const sandbox = ModuleSandbox.forModule(exampleTopicId, exampleModuleId);
    sandbox.writeFile('content.json', '{"a":1}');
    expect(sandbox.readFile('content.json').toString('utf8')).toBe('{"a":1}');
    expect(existsSync(path.join(sandbox.moduleDir, 'content.json'))).toBe(true);
  });

  it('rejects a write that resolves outside the module directory via traversal', () => {
    freshRoot();
    const sandbox = ModuleSandbox.forModule(exampleTopicId, exampleModuleId);
    expect(() => sandbox.writeFile('../../escape.txt', 'x')).toThrow();
  });

  it.skipIf(!SYMLINKS_SUPPORTED)('rejects a symlink that points outside the module directory', () => {
    freshRoot();
    const sandbox = ModuleSandbox.forModule(exampleTopicId, exampleModuleId);
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'la-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    writeFileSync(outsideFile, 'secret');
    const linkPath = path.join(sandbox.moduleDir, 'escape-link');
    symlinkSync(outsideFile, linkPath);
    expect(() => sandbox.readFile('escape-link')).toThrow();
  });
});
