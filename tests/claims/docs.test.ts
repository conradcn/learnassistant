// FRACTAL: covers (none) | type unit
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
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

// A doc names a package as a *claim about our dependencies* only when the prose says so:
// "the app depends on `x`", "the `x` package", "npm install x", "from 'x'". A bare code span is
// not enough — the docs use spans for CLIs, providers, hostnames, paths and field names, none of
// which are dependencies. Each pattern captures the package name in group 1.
const NAME = String.raw`(@[a-z0-9~-][a-z0-9._~-]*\/[a-z0-9._~-]+|[a-z0-9][a-z0-9._~-]*)`;
const TICK = String.raw`\x60`;
const SUBJECT = String.raw`(?:we|the app|this (?:app|project|repo)|LearnAssistant)`;
const VERB = String.raw`(?:depends? on|requires?|bundles?|ships with|vendors?)`;
const claimPatterns = [
  new RegExp(`${SUBJECT}` + String.raw`\s+(?:also\s+)?${VERB}\s+(?:the\s+)?` + `${TICK}${NAME}${TICK}`, 'gi'),
  new RegExp(`${TICK}${NAME}${TICK}` + String.raw`\s+(?:npm\s+)?(?:package|librar(?:y|ies)|dependency)`, 'gi'),
  new RegExp(String.raw`npm\s+(?:install|i|add)\s+(?:--?\S+\s+)*` + NAME, 'gi'),
  new RegExp(String.raw`(?:from|require\()\s*['"]` + NAME + String.raw`(?:\/[^'"]*)?['"]`, 'gi'),
];

function packageClaims(text: string): { name: string; line: number }[] {
  const claims: { name: string; line: number }[] = [];
  text.split('\n').forEach((line, i) => {
    for (const pattern of claimPatterns) {
      for (const m of line.matchAll(pattern)) claims.push({ name: m[1], line: i + 1 });
    }
  });
  return claims;
}

describe('docs claims', () => {
  it('every FRACTAL id in src/** and app/** resolves to an F-ID in features.md or a C-ID in architecture.md', () => {
    const featuresText = readFileSync(path.join(repoRoot, 'features.md'), 'utf8');
    const architectureText = readFileSync(path.join(repoRoot, 'architecture.md'), 'utf8');

    const files = ['src', 'app']
      .map((dir) => path.join(repoRoot, dir))
      .flatMap((dir) => walk(dir))
      .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
    expect(files.length).toBeGreaterThan(0);

    const idPattern = /\b([FC]\d+)\b/g;
    let checkedAtLeastOne = false;

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const firstLine = content.split('\n')[0];
      if (!firstLine.startsWith('// FRACTAL:')) continue;

      const ids = [...firstLine.matchAll(idPattern)].map((m) => m[1]);
      for (const id of ids) {
        checkedAtLeastOne = true;
        const isFeature = id.startsWith('F') && new RegExp(String.raw`^##\s*${id}:`, 'm').test(featuresText);
        const isComponent =
          id.startsWith('C') && new RegExp(String.raw`^##\s*${id}:`, 'm').test(architectureText);
        expect(isFeature || isComponent, `${id} in ${file} not found in features.md/architecture.md`).toBe(true);
      }
    }

    expect(checkedAtLeastOne).toBe(true);
  });

  it('reads dependency claims out of prose, and only dependency claims', () => {
    expect(packageClaims('The app depends on `better-sqlite3` for storage.').map((c) => c.name)).toEqual([
      'better-sqlite3',
    ]);
    expect(packageClaims('Scheduling uses the `ts-fsrs` package.').map((c) => c.name)).toEqual(['ts-fsrs']);
    expect(packageClaims("Run `npm install zod`, then `import x from '@anthropic-ai/sdk'`.").map((c) => c.name)).toEqual(
      ['zod', '@anthropic-ai/sdk'],
    );
    // Not dependency claims: a CLI, a Docker mapping, a provider name, a struct field.
    expect(packageClaims('Run `ollama serve`; the `host-gateway` mapping resolves `openai`.')).toEqual([]);
    expect(packageClaims('(understanding `to` depends on `from`)')).toEqual([]);
  });

  it('every package named as a dependency in the docs appears in package.json', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const knownDeps = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);

    const topLevel = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'features.md', 'architecture.md'];
    const docsDir = path.join(repoRoot, 'docs');
    const docFiles = [
      ...topLevel.map((f) => path.join(repoRoot, f)).filter((f) => existsSync(f)),
      ...(existsSync(docsDir) ? walk(docsDir).filter((f) => f.endsWith('.md')) : []),
    ];
    expect(docFiles.length).toBeGreaterThan(0);

    for (const file of docFiles) {
      for (const { name, line } of packageClaims(readFileSync(file, 'utf8'))) {
        expect(
          knownDeps.has(name),
          `${path.relative(repoRoot, file)}:${line} names "${name}" as a dependency, but it is not in package.json`,
        ).toBe(true);
      }
    }
  });
});
