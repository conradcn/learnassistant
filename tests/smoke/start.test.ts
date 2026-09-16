// FRACTAL: covers project | type smoke | targets start.bat,start.sh
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { START_PORT as PORT, START_MARKER as MARKER } from '../fixtures/app-constants';

const isWin = process.platform === 'win32';

const children: ChildProcess[] = [];

function killTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (isWin) execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

afterEach(() => {
  for (const c of children.splice(0)) killTree(c);
});

function launch(cwd: string, port: number) {
  // WHY the absolute path: cmd.exe refuses to resolve a bare `start.bat` from the cwd
  // when NoDefaultCurrentDirectoryInExePath is set (Git Bash sets it), so a relative
  // name here fails to launch on exactly the machines the script exists for.
  const script = path.resolve(cwd, isWin ? 'start.bat' : 'start.sh');
  const child = spawn(isWin ? 'cmd.exe' : 'bash', isWin ? ['/c', script] : [script], {
    cwd,
    env: { ...process.env, PORT: String(port), LA_DATA_ROOT: path.join(cwd, '.smoke-data') },
    detached: !isWin,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  child.stdout?.on('data', (b) => (out += String(b)));
  child.stderr?.on('data', (b) => (out += String(b)));
  return { child, output: () => out };
}

async function waitForServer(port: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last = 'never responded';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.status < 500) return { status: res.status, body: (await res.text()).slice(0, 200) };
      last = `status ${res.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`start script never brought the server up on ${port}: ${last}`);
}

async function portIsFree(port: number) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return false;
  } catch {
    return true;
  }
}

describe('start script contract', () => {
  it('exists for both platforms and is wired to the canonical start command', () => {
    expect(fs.existsSync('start.bat')).toBe(true);
    expect(fs.existsSync('start.sh')).toBe(true);
    const bat = fs.readFileSync('start.bat', 'utf8');
    const sh = fs.readFileSync('start.sh', 'utf8');
    for (const script of [bat, sh]) {
      expect(script).toContain('npm run start');
      expect(script).toContain(String(PORT));
    }
    expect(bat).toContain('\r\n');
    expect(sh).not.toContain('\r\n');
    // Playwright must launch the app through this same script, not an inlined dev command.
    const pw = fs.readFileSync('playwright.config.ts', 'utf8');
    expect(pw).toContain('start.bat');
    expect(pw).toContain('start.sh');
    // WHY the negative too: naming the scripts is not the point — launching *through*
    // them is. An inlined dev command would satisfy a contains-check for the filenames
    // while quietly testing something the user never runs.
    expect(pw).not.toMatch(/command:\s*['"`].*next dev/);
    expect(pw).toContain('command: startScript');
  });

  it(
    'launches the app on the drawn port with cached deps, then tears down cleanly',
    { timeout: 420_000 },
    async () => {
      // WHY this guard: PORT is the port the SHIPPED app listens on, so a learner's own
      // running instance answers here. Without the check, `waitForServer` greets that
      // instance, the assertions grade a server this test never launched, and the teardown
      // check then fails on a process it has no business killing. Refuse, and say why.
      if (!(await portIsFree(PORT))) {
        throw new Error(
          `port ${PORT} is already serving something — stop the running app before the start-script smoke test`,
        );
      }
      const { child, output } = launch(process.cwd(), PORT);
      const res = await waitForServer(PORT, 360_000);
      expect(res.status).toBeLessThan(500);
      expect(output()).toContain(MARKER);
      // cached-deps path must not re-run the installer
      expect(output()).not.toContain('Installing dependencies');

      killTree(child);
      await new Promise((r) => setTimeout(r, 3000));
      expect(await portIsFree(PORT)).toBe(true);
    },
  );

  it.skipIf(process.env.FRACTAL_SMOKE_FRESH !== '1')(
    'installs dependencies then launches from a fresh clone',
    { timeout: 900_000 },
    async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-fresh-'));
      execFileSync('git', ['clone', '--depth', '1', process.cwd(), tmp], { stdio: 'pipe' });
      expect(fs.existsSync(path.join(tmp, 'node_modules'))).toBe(false);

      const freshPort = PORT + 1;
      const { output } = launch(tmp, freshPort);
      const res = await waitForServer(freshPort, 840_000);
      expect(res.status).toBeLessThan(500);
      expect(output()).toContain('Installing dependencies');
      expect(output()).toContain(MARKER);
    },
  );
});
