// FRACTAL: covers project | type regression | targets package.json,scripts/dev.mjs,instrumentation.ts,README.md,CONTRIBUTING.md
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

/**
 * WHY these are permanent: `npm run dev` is the documented edit-reload loop
 * (CONTRIBUTING.md, "Working on the code"), and it was broken on Windows in two
 * independent ways at once. Both failures were invisible to `npm run build`, which is what
 * CI and every other suite exercise, so nothing else in the battery would catch a
 * reintroduction.
 */
describe('the dev server starts and serves on both platforms', () => {
  it('does not put POSIX shell expansion in the dev script', () => {
    // WHY: the script was `next dev -p ${PORT:-31544}`. npm runs scripts through cmd.exe on
    // Windows, which passes `${PORT:-31544}` through literally; Next took that as its port
    // and exited before serving. The default belongs in JS, not in shell syntax.
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
    expect(scripts.dev).toBeDefined();
    expect(scripts.dev).not.toMatch(/\$\{|\$[A-Z_]/);
  });

  it('keeps node-only imports out of the edge copy of instrumentation', () => {
    // WHY: Next compiles instrumentation.ts for the edge layer too, and `next dev` does so
    // even though the middleware declares `runtime = 'nodejs'`. A static `node:fs` import
    // there fails to resolve and every dev request answers 500 with a ModuleBuildError.
    // The handler must therefore stay behind a runtime-guarded dynamic import — and the
    // guard must be a positive `if` block, since webpack only prunes the import when the
    // condition folds to false.
    const entry = read('instrumentation.ts');
    expect(entry).not.toMatch(/^\s*import\s[^\n]*['"]node:/m);
    expect(entry).toMatch(/if\s*\(\s*process\.env\.NEXT_RUNTIME\s*===\s*'nodejs'\s*\)\s*\{/);
    expect(entry).toMatch(/await import\('\.\/instrumentation-node'\)/);
    // the real handler still exists and is still the one holding the node API
    expect(read('instrumentation-node.ts')).toMatch(/from 'node:fs'/);
  });

  it('documents the fresh-clone smoke in a form PowerShell can run', () => {
    // WHY: both docs gave only `FRACTAL_SMOKE_FRESH=1 npm test -- ...`. PowerShell has no
    // inline env-var prefix, so that line is a parse error for every Windows contributor —
    // and ci.yml sets the variable with an `env:` block, so CI never runs the documented
    // form and could not catch it. Wherever the POSIX prefix appears, the PowerShell
    // equivalent has to appear too.
    for (const doc of ['README.md', 'CONTRIBUTING.md']) {
      const text = read(doc);
      if (!text.includes('FRACTAL_SMOKE_FRESH=1 npm test')) continue;
      expect(text, doc).toMatch(/\$env:FRACTAL_SMOKE_FRESH\s*=\s*1;\s*npm test/);
    }
  });
});
