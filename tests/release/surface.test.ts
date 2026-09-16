// FRACTAL: covers F6 | type release
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === '.next') continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

describe('release surface', () => {
  it('transport.fake is not referenced by any src file other than itself', () => {
    const srcDir = path.join(repoRoot, 'src');
    const files = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith(path.join('cli', 'transport.fake.ts'))) continue;
      const text = readFileSync(file, 'utf8');
      if (text.includes('transport.fake')) {
        offenders.push(path.relative(repoRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('transport.fake.ts asserts it is not in a release build', () => {
    const text = readFileSync(path.join(repoRoot, 'src', 'cli', 'transport.fake.ts'), 'utf8');
    expect(text).toContain("assertNotInRelease('cli/transport.fake')");
  });

  it('no source file uses a definedness-style env gate', () => {
    const srcDir = path.join(repoRoot, 'src');
    const files = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
    const badPatterns: { name: string; re: RegExp }[] = [
      { name: 'strict-not-undefined', re: /process\.env\.[A-Za-z_][A-Za-z0-9_]*\s*!==\s*undefined/ },
      { name: 'double-bang truthiness', re: /!!\s*process\.env\.[A-Za-z_][A-Za-z0-9_]*/ },
      { name: "'X' in process.env", re: /['"][A-Za-z_][A-Za-z0-9_]*['"]\s+in\s+process\.env/ },
      { name: 'bare if(process.env.X)', re: /if\s*\(\s*process\.env\.[A-Za-z_][A-Za-z0-9_]*\s*\)/ },
    ];

    const offenders: { file: string; pattern: string; line: string }[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        for (const { name, re } of badPatterns) {
          if (re.test(line)) {
            offenders.push({ file: path.relative(repoRoot, file), pattern: name, line: line.trim() });
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
