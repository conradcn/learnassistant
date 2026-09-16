// FRACTAL: covers (none) | type unit | targets package.json,.nvmrc,.npmrc,.github/workflows/ci.yml
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

const pkg = JSON.parse(read('package.json')) as { engines: { node: string } };
const engineRange = pkg.engines.node;

/**
 * A caret-disjunction matcher, deliberately not `semver` — semver is only a transitive
 * dependency here, and the range this guards is written in one shape (`^X.Y.Z || ...`).
 * Anything else throws rather than silently passing.
 */
type Disjunct = { major: number; minor: number; patch: number };

const disjuncts: Disjunct[] = engineRange.split('||').map((part) => {
  const m = /^\s*\^(\d+)\.(\d+)\.(\d+)\s*$/.exec(part);
  if (!m) throw new Error(`engines.node disjunct is not a plain caret range: "${part.trim()}"`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
});

/** `version` may be partial ("24", "20.19") — missing components read as 0. */
function satisfiesEngines(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version
    .trim()
    .replace(/^v/, '')
    .split('.')
    .map((n) => Number(n));
  return disjuncts.some(
    (d) =>
      d.major === major &&
      (minor > d.minor || (minor === d.minor && patch >= d.patch)),
  );
}

const floor = disjuncts.reduce((a, b) => (a.major <= b.major ? a : b));
const floorText = `${floor.major}.${floor.minor}`;
const nvmrc = read('.nvmrc').trim();

describe('declared Node engine range', () => {
  it('is satisfied by the version .nvmrc pins', () => {
    expect(satisfiesEngines(nvmrc), `.nvmrc pins ${nvmrc}, outside "${engineRange}"`).toBe(true);
  });

  it('is refused rather than warned about, via engine-strict', () => {
    expect(read('.npmrc')).toMatch(/^engine-strict\s*=\s*true$/m);
  });

  // The point of the whole range. `npm ci` only checks the *root* engines field against the
  // running Node; a dependency that raises its own floor above ours goes unnoticed until a
  // contributor on the floor version hits it at runtime — which is exactly how pdfjs-dist's
  // `Promise.withResolvers()` call became reachable under the old `>=20.11`.
  it('is not contradicted by any installed dependency', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (name.startsWith('.')) continue;
        const full = path.join(dir, name);
        if (name.startsWith('@')) {
          walk(full);
          continue;
        }
        let dep: { name?: string; engines?: { node?: string } };
        try {
          dep = JSON.parse(readFileSync(path.join(full, 'package.json'), 'utf8'));
        } catch {
          continue;
        }
        const range = dep.engines?.node;
        if (!range) continue;
        // Only the versions we advertise need to work. A dependency range we do not
        // cover at *every* point is fine; one that excludes our floor or .nvmrc is not.
        for (const v of [`${floorText}.0`, nvmrc]) {
          if (!coarseSatisfies(v, range)) offenders.push(`${dep.name ?? name} requires "${range}" (excludes Node ${v})`);
        }
      }
    };
    walk(path.join(repoRoot, 'node_modules'));
    expect(offenders.sort()).toEqual([]);
  });

  it('is the range every workflow and document states', () => {
    // Both YAML shapes the matrix uses: the `node: ['24']` flow sequence and the
    // `node: '20.19'` scalar inside `include:`.
    const ciNodes = [...read('.github/workflows/ci.yml').matchAll(/^\s*(?:-\s+)?node:(.+)$/gm)].flatMap(
      (m) => [...m[1].matchAll(/'([^']+)'/g)].map((q) => q[1]),
    );
    expect(ciNodes.length).toBeGreaterThan(1);
    for (const v of ciNodes) expect(satisfiesEngines(v), `ci.yml runs Node ${v}`).toBe(true);
    expect(ciNodes, 'ci.yml must exercise the .nvmrc version').toContain(nvmrc);
    expect(ciNodes, 'ci.yml must exercise the engines floor').toContain(floorText);

    for (const doc of ['README.md', 'CONTRIBUTING.md', 'docs/TROUBLESHOOTING.md']) {
      const text = read(doc);
      expect(text, `${doc} must state the supported floor`).toContain(floorText);
      // Every `Node <x.y>` claim in the prose has to be a version we actually support.
      const claimed = [...text.matchAll(/Node(?:\.js)?\s*>?=?\s*(\d+\.\d+(?:\.\d+)?)/g)].map((m) => m[1]);
      for (const v of claimed) {
        expect(satisfiesEngines(v), `${doc} advertises Node ${v}, outside "${engineRange}"`).toBe(true);
      }
    }
  });
});

/**
 * Enough of npm's range grammar to evaluate the shapes dependencies actually publish:
 * `>=20.16.0`, `20.x || 22.x`, `^18.18.0 || >=21.1.0`, `>=v12.22.7`. Unparseable
 * comparators are treated as satisfied — this test exists to catch real exclusions, not
 * to reimplement semver.
 */
function coarseSatisfies(version: string, range: string): boolean {
  const [ma, mi, pa] = version.split('.').map(Number);
  const cmp = (b: number[]) => (ma - b[0]) || (mi - (b[1] ?? 0)) || (pa - (b[2] ?? 0));
  return range.split('||').some((clause) =>
    clause
      .trim()
      .split(/\s+(?=[<>^~=\d])/)
      .every((raw) => {
        const c = raw.trim().replace(/^v|(?<=[<>=~^])\s*v/g, '');
        let m: RegExpExecArray | null;
        if ((m = /^(\d+)\.x$/.exec(c))) return ma === Number(m[1]);
        if ((m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(c)))
          return ma === Number(m[1]) && cmp([Number(m[1]), Number(m[2]), Number(m[3])]) >= 0;
        if ((m = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(c)))
          return cmp([Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]) >= 0;
        if ((m = /^<\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(c)))
          return cmp([Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]) < 0;
        return true;
      }),
  );
}
