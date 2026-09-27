// FRACTAL: covers F1 | type regression
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

const HARNESS_FILES = [
  'tests/setup.ts',
  'vitest.config.ts',
  'playwright.config.ts',
  'scripts/start.mjs',
  'scripts/package-release.mjs',
];

const UNSCOPED_KILLS: readonly RegExp[] = [
  /\bkillall\b/,
  /\bpkill\b/,
  /taskkill[^\n]*\/IM/i,
  /process\.kill\(\s*0\s*[,)]/,
  /process\.kill\(\s*-\d/,
  /Get-Process[^\n]*\|\s*Stop-Process/i,
  /\bexec(?:Sync)?\([^)]*kill\s+-9\s+\$\(/,
];

const DANGEROUS_PATHS: readonly RegExp[] = [
  /rmSync\(\s*['"`]\/['"`]/,
  /rmSync\(\s*['"`][A-Za-z]:\\{1,2}['"`]/,
  /rmSync\(\s*os\.homedir\(\)/,
  /rmSync\(\s*['"`]~/,
  /rm\s+-rf\s+\//,
  /Remove-Item[^\n]*\s[A-Za-z]:\\\s/,
];

function readHarness(): { file: string; source: string }[] {
  return HARNESS_FILES.filter((f) => existsSync(path.join(ROOT, f))).map((f) => ({
    file: f,
    source: readFileSync(path.join(ROOT, f), 'utf8'),
  }));
}

describe('the test harness stays inside its own sandbox', () => {
  const harness = readHarness();

  it('has the harness files it claims to check', () => {
    expect(harness.map((h) => h.file)).toContain('tests/setup.ts');
    expect(harness.length).toBeGreaterThanOrEqual(4);
  });

  it('never kills processes it did not start', () => {
    for (const { file, source } of harness) {
      for (const pattern of UNSCOPED_KILLS) {
        expect(pattern.test(source), `${file} matched ${pattern}`).toBe(false);
      }
    }
  });

  it('never removes a path outside the project or the temp directory', () => {
    for (const { file, source } of harness) {
      for (const pattern of DANGEROUS_PATHS) {
        expect(pattern.test(source), `${file} matched ${pattern}`).toBe(false);
      }
    }
  });

  it('scopes global setup to a temp directory it created itself', () => {
    const setup = readFileSync(path.join(ROOT, 'tests', 'setup.ts'), 'utf8');
    expect(setup).toContain('mkdtempSync');
    expect(setup).toContain('os.tmpdir()');
    const removals = setup.match(/rmSync\(([^,]+),/g) ?? [];
    expect(removals.length).toBeGreaterThan(0);
    for (const removal of removals) expect(removal).toContain('tempRoot');
  });

  it('points every test data root at a temp directory, never at the project', () => {
    expect(process.env.LA_DATA_ROOT).toBeTypeOf('string');
    const dataRoot = path.resolve(process.env.LA_DATA_ROOT ?? '');
    const tmp = path.resolve(os.tmpdir());
    const rel = path.relative(tmp, dataRoot);
    expect(rel.startsWith('..'), dataRoot).toBe(false);
    // WHY isAbsolute: on a Windows runner the checkout (D:) and the temp dir (C:) are on
    // different drives, and path.relative between drives returns an absolute path.
    const fromProject = path.relative(ROOT, dataRoot);
    expect(fromProject.startsWith('..') || path.isAbsolute(fromProject), dataRoot).toBe(true);
  });

  it('leaves no durable residue inside the project directory', () => {
    const stray = readdirSync(ROOT).filter((e) => e.startsWith('learn-assistant-test-') || e === 'learn.db');
    expect(stray).toEqual([]);
  });
});
