#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const port = process.env.PORT ?? '31544';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(cmd, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, ...extraEnv },
    });
    child.on('error', reject);
    // WHY: reporting only `code` hid the most useful half of a silent death. A child
    // killed by a signal exits with code === null; a native abort on Windows surfaces
    // as an unsigned status such as 4294967295. Both are now stated plainly.
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const signed = typeof code === 'number' && code > 0x7fffffff ? code - 0x100000000 : code;
      reject(
        new Error(
          `${cmd} exited with code ${code}${signed !== code ? ` (signed ${signed})` : ''}, signal ${signal ?? 'none'}`,
        ),
      );
    });
  });
}

// WHY (H8): `next start` serves whatever is already in .next. Launching only on the
// existence of BUILD_ID meant an edited tree came up as the last build — the app looked
// like it was running, the E2E suite went green, and neither was testing the current
// source. The build is therefore keyed to the newest source file, not to a marker file.
const SOURCE_DIRS = ['app', 'src', 'public'];
const SOURCE_FILES = ['package.json', 'package-lock.json', 'next.config.mjs', 'tsconfig.json'];

function newestMtime(target) {
  let newest = 0;
  const visit = (p) => {
    let info;
    try {
      info = statSync(p);
    } catch {
      return;
    }
    if (info.isDirectory()) {
      for (const entry of readdirSync(p)) visit(path.join(p, entry));
      return;
    }
    if (info.mtimeMs > newest) newest = info.mtimeMs;
  };
  visit(target);
  return newest;
}

// WHY: BUILD_ID is not a completion marker. `next build` writes it early, well before
// the final manifests, so an interrupted build (killed process tree, Ctrl-C, sleep)
// leaves a tree that has BUILD_ID, .next/server and .next/static but no
// prerender-manifest.json — which `next start` opens unconditionally at boot and dies
// on. Keying "is it built?" to BUILD_ID alone made that state permanent: the launcher
// skipped the rebuild forever. Completeness is therefore judged by the whole set of
// terminal-phase artifacts, and freshness by the oldest of their mtimes.
const BUILD_MARKERS = [
  'BUILD_ID',
  'prerender-manifest.json',
  'routes-manifest.json',
  'required-server-files.json',
];

function inspectBuild() {
  const present = [];
  let oldest = Infinity;
  for (const marker of BUILD_MARKERS) {
    const file = path.join(root, '.next', marker);
    if (!existsSync(file)) continue;
    present.push(marker);
    oldest = Math.min(oldest, statSync(file).mtimeMs);
  }
  return {
    complete: present.length === BUILD_MARKERS.length,
    partial: present.length > 0 && present.length < BUILD_MARKERS.length,
    builtAt: present.length === BUILD_MARKERS.length ? oldest : 0,
  };
}

const build = inspectBuild();
const sourceAt = Math.max(
  ...[...SOURCE_DIRS, ...SOURCE_FILES].map((entry) => newestMtime(path.join(root, entry))),
);

if (build.partial) {
  console.log('[learn-assistant] Previous build is incomplete — rebuilding.');
  await run(npm, ['run', 'build']);
} else if (!build.complete) {
  console.log('[learn-assistant] No production build found — building once.');
  await run(npm, ['run', 'build']);
} else if (sourceAt > build.builtAt) {
  console.log('[learn-assistant] Sources changed since the last build — rebuilding.');
  await run(npm, ['run', 'build']);
}

console.log(`[learn-assistant] Open http://localhost:${port}`);
// WHY: a bare top-level await turned every non-zero child exit into an unhandled
// rejection trace pointing at this file, which read as a bug in the launcher rather
// than a report about the server. The failure is now stated as a message.
async function startServer() {
  const launchedAt = Date.now();
  try {
    await run(npm, ['exec', '--', 'next', 'start', '-p', port], { PORT: port });
    return null;
  } catch (e) {
    // A crash within seconds of launch is a boot failure, not a server that ran and
    // stopped — the only case worth spending a rebuild on.
    return { error: e, early: Date.now() - launchedAt < 10_000 };
  }
}

let failure = await startServer();

// Self-healing: a truncated .next kills `next start` at boot every time, so wipe it and
// build once. Guarded to a single retry — a genuinely broken build must not loop.
if (failure && failure.early && !inspectBuild().complete) {
  console.error('[learn-assistant] The build is incomplete — removing .next and rebuilding once.');
  try {
    rmSync(path.join(root, '.next'), { recursive: true, force: true });
    await run(npm, ['run', 'build']);
    console.log(`[learn-assistant] Open http://localhost:${port}`);
    failure = await startServer();
  } catch (e) {
    failure = { error: e, early: false };
  }
}

if (failure) {
  const e = failure.error;
  console.error(`[learn-assistant] The server stopped unexpectedly: ${e instanceof Error ? e.message : String(e)}`);
  console.error('[learn-assistant] See data/logs/app-<date>.ndjson for the last events before it stopped.');
  process.exitCode = 1;
}
