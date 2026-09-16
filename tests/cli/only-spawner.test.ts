// FRACTAL: covers F6 | type unit
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/**
 * WHY this test exists: C2 is the one component allowed to start a process carrying the
 * learner's words, and that is what makes the sandbox (F6), the timeouts and the
 * concurrency limit enforceable in one place rather than wherever a caller felt like
 * spawning.
 */
describe('starting a process', () => {
  it('happens in one place in src, and nowhere else', () => {
    const spawners = walk(path.resolve('src'))
      .filter((f) => /from '(node:)?child_process'/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(path.resolve('src'), f).split(path.sep).join('/'))
      .sort();
    // WHY llama.ts is allowed here: it starts an inference SERVER, not a session. The
    // argv it builds carries a model path and a port and no learner content of any kind,
    // and the prompt still travels over HTTP from the transport. The assertions below
    // are what keep that true.
    expect(spawners).toEqual(['cli/availability.ts', 'cli/llama.ts', 'cli/run-session.ts']);

    const availability = readFileSync(path.resolve('src/cli/availability.ts'), 'utf8');
    expect(availability).toContain('--version');
    expect(availability).not.toMatch(/prompt|CliSessionSpec/);

    const llama = readFileSync(path.resolve('src/cli/llama.ts'), 'utf8');
    expect(llama).toContain('--port');
    // the spawn's argv is built from settings only — no prompt, no buffer, no message
    expect(llama.slice(llama.indexOf('const argv'), llama.indexOf('spawn(settings.binPath'))).not.toMatch(
      /prompt|buffer|messages/,
    );
  });
});
