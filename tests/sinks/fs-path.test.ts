// FRACTAL: covers F6 | type unit
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModuleSandbox } from '@/cli/sandbox';
import { resetConfigCache } from '@/core/config';
import { exampleTopicId, exampleModuleId } from '@/shapes';

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-fspath-'));
  process.env.LA_DATA_ROOT = dataRoot;
  resetConfigCache();
});

function canCreateSymlink(): boolean {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'la-symlink-probe2-'));
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

describe('fs-path sink-abuse battery', () => {
  it('rejects an absolute path passed as a relative id', () => {
    const sandbox = ModuleSandbox.forModule(exampleTopicId, exampleModuleId);
    const absolute = process.platform === 'win32' ? 'C:\\Windows\\System32\\evil.txt' : '/etc/passwd';
    expect(() => sandbox.writeFile(absolute, 'x')).toThrow();
  });

  it('rejects a plain ".." traversal', () => {
    const sandbox = ModuleSandbox.forModule(exampleTopicId, exampleModuleId);
    expect(() => sandbox.writeFile('../escape.txt', 'x')).toThrow();
  });

  it('rejects a URL-encoded ".." traversal', () => {
    const sandbox = ModuleSandbox.forModule(exampleTopicId, exampleModuleId);
    expect(() => sandbox.writeFile('%2e%2e/escape.txt', 'x')).toThrow();
  });

  it('rejects a double URL-encoded ".." traversal', () => {
    const sandbox = ModuleSandbox.forModule(exampleTopicId, exampleModuleId);
    expect(() => sandbox.writeFile('%252e%252e/escape.txt', 'x')).toThrow();
  });

  it.skipIf(!SYMLINKS_SUPPORTED)('rejects a symlink escaping the module directory', () => {
    const sandbox = ModuleSandbox.forModule(exampleTopicId, exampleModuleId);
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'la-fspath-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    writeFileSync(outsideFile, 'secret');
    const linkPath = path.join(sandbox.moduleDir, 'escape-link');
    symlinkSync(outsideFile, linkPath);
    expect(() => sandbox.readFile('escape-link')).toThrow();
  });

  it('rejects an over-long relative path', () => {
    const sandbox = ModuleSandbox.forModule(exampleTopicId, exampleModuleId);
    const overLong = `${'a'.repeat(600)}.txt`;
    expect(() => sandbox.writeFile(overLong, 'x')).toThrow();
  });

  it('rejects an empty relative path', () => {
    const sandbox = ModuleSandbox.forModule(exampleTopicId, exampleModuleId);
    expect(() => sandbox.writeFile('', 'x')).toThrow();
  });
});
