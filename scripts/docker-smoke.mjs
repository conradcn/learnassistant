#!/usr/bin/env node
// FRACTAL: covers project | type smoke | targets Dockerfile,docker-compose.yml
/**
 * The container's fresh-start smoke: the same thing tests/smoke/start.test.ts asks of
 * start.sh and start.bat, asked of `docker compose up`.
 *
 *   1. an empty data directory — no learn.db, no config, no token
 *   2. build the image and bring the stack up
 *   3. the app answers on the project's port, at a Host header a browser would send
 *   4. a topic can be created and comes back on the dashboard
 *   5. the topic survives `docker compose down` + `up` — i.e. the bind mount is real
 *      persistence and not a layer that dies with the container
 *
 * WHY it is a script and not only a vitest case: `docker compose build` is minutes of
 * work, so this has to be runnable on its own, in CI, without a test runner around it.
 * tests/smoke/docker.test.ts is a thin wrapper that shells out to exactly this.
 *
 * Usage:  node scripts/docker-smoke.mjs [--keep]
 *   --keep   leave the stack running and the data directory in place afterwards
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
// WHY the .ts specifier: Node strips the types at load, so the script and the vitest
// suites share one source for the port instead of each re-deriving it.
import { START_PORT } from '../tests/fixtures/app-constants.ts';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const PORT = Number(process.env.LA_SMOKE_PORT ?? START_PORT);
const DATA_DIR = process.env.LA_SMOKE_DATA_DIR ?? './.docker-smoke-data';
const ABS_DATA_DIR = path.resolve(root, DATA_DIR);
// WHY its own project name: this must never touch the stack a learner has running, nor
// its named volumes. `docker compose -p learn-assistant-smoke down -v` at the end then
// removes only what this script made.
const PROJECT = 'learn-assistant-smoke';
const KEEP = process.argv.includes('--keep');

const BUILD_TIMEOUT_MS = 20 * 60_000;
const BOOT_TIMEOUT_MS = 3 * 60_000;

const env = {
  ...process.env,
  PORT: String(PORT),
  LA_DATA_DIR: DATA_DIR,
  // WHY the provider is pinned here: the smoke tests startup and the store, not an AI.
  // Left at the default the container would print its "no claude CLI in here" notice,
  // which is correct but is noise in a run about whether the server comes up.
  LA_PROVIDER: 'ollama',
  // WHY the host's own ids: the compose file runs as 1000:1000, and the fresh data
  // directory made below belongs to whoever runs this. A GitHub runner is uid 1001, so the
  // entrypoint refuses the bind mount and the container restarts until the boot wait runs
  // out. This is the LA_UID/LA_GID fix the entrypoint's own message tells a learner to make.
  // Windows and macOS hosts have no getuid (or Docker Desktop ignores ownership), so the
  // compose default stands there.
  ...(typeof process.getuid === 'function' && process.platform !== 'darwin'
    ? { LA_UID: process.env.LA_UID ?? String(process.getuid()), LA_GID: process.env.LA_GID ?? String(process.getgid()) }
    : {}),
};

let step = 0;
function say(msg) {
  console.log(`[docker-smoke] ${msg}`);
}
function stage(msg) {
  step += 1;
  console.log(`\n[docker-smoke] ${step}. ${msg}`);
}
function fail(msg) {
  process.exitCode = 1;
  throw new Error(msg);
}

function compose(args, { timeout = 120_000, capture = false } = {}) {
  const argv = ['compose', '-p', PROJECT, ...args];
  const res = spawnSync('docker', argv, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout,
    stdio: capture ? 'pipe' : ['ignore', 'inherit', 'inherit'],
  });
  if (res.error) fail(`docker ${argv.join(' ')}: ${res.error.message}`);
  if (res.status !== 0) {
    if (capture) console.error(res.stdout ?? '', res.stderr ?? '');
    fail(`docker ${argv.join(' ')} exited ${res.status}`);
  }
  return capture ? `${res.stdout ?? ''}${res.stderr ?? ''}` : '';
}

async function portIsFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return false;
  } catch {
    return true;
  }
}

/** Any status below 500 means the server is answering; /api/health is 401 until a page
 *  render has minted this launch's token, and a 401 is still a live server. */
async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = 'never responded';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/health`, { signal: AbortSignal.timeout(4000) });
      if (res.status < 500) return res.status;
      last = `status ${res.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await sleep(1000);
  }
  fail(`the container never answered on ${PORT}: ${last}`);
  return 0;
}

/** The per-launch token, read off the bind mount — which is itself the proof that the
 *  container and the host are looking at the same directory. */
async function readToken() {
  const file = path.join(ABS_DATA_DIR, '.session-token');
  for (let i = 0; i < 60; i += 1) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f]{64}$/.test(raw)) return raw;
    } catch {
      // not written yet
    }
    await sleep(500);
  }
  fail(`no valid .session-token appeared in ${DATA_DIR} — the ./data bind mount is not shared`);
  return '';
}

async function api(pathname, token, init = {}) {
  const res = await fetch(`http://localhost:${PORT}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-la-token': token, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body };
}

function teardown() {
  if (KEEP) {
    say(`--keep: leaving the stack up and ${DATA_DIR} in place`);
    return;
  }
  say('tearing the stack down');
  spawnSync('docker', ['compose', '-p', PROJECT, 'down', '-v', '--remove-orphans'], {
    cwd: root,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 120_000,
  });
  fs.rmSync(ABS_DATA_DIR, { recursive: true, force: true });
}

/**
 * The shipped default, asserted from the compose file rather than from the traffic below.
 *
 * WHY separately: the live half of this smoke can be pointed at another port when the
 * project's own port is already serving something (LA_SMOKE_PORT), and a run that moved
 * would otherwise stop checking the one number a new user depends on. This reads the
 * config with no overrides at all, so it is the number `docker compose up` would use.
 */
function assertDefaultPort() {
  const res = spawnSync('docker', ['compose', '-f', path.join(root, 'docker-compose.yml'), 'config', '--format', 'json'], {
    cwd: root,
    // WHY a stripped environment: this must read the file's defaults, not this run's
    // overrides. Anything named LA_* or PORT here would be interpolated into the answer.
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LA_') && k !== 'PORT')),
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (res.status !== 0) fail(`docker compose config failed: ${res.stderr ?? ''}`);
  const svc = JSON.parse(res.stdout).services.app;
  const expected = String(START_PORT);
  const published = svc.ports?.[0];
  if (String(published?.published) !== expected || String(published?.target) !== expected) {
    fail(`compose publishes ${published?.published}:${published?.target}, not ${expected}:${expected}`);
  }
  if (String(svc.environment?.PORT) !== expected) {
    fail(`the container's PORT defaults to ${svc.environment?.PORT}, not ${expected}`);
  }
  if (svc.environment?.LA_DATA_ROOT !== '/app/data') fail('LA_DATA_ROOT is not /app/data in the container');
  const dataMount = (svc.volumes ?? []).find((v) => v.target === '/app/data');
  if (dataMount?.type !== 'bind' || !dataMount.source.endsWith('data')) {
    fail(`/app/data is not bound to ./data (got ${JSON.stringify(dataMount)})`);
  }
  say(`compose defaults: ${expected}:${expected}, PORT=${expected}, ./data -> /app/data (bind)`);
}

async function main() {
  stage(`the shipped default is the project's assigned port ${START_PORT}`);
  assertDefaultPort();

  stage(`a fresh, empty data directory at ${DATA_DIR}`);
  fs.rmSync(ABS_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(ABS_DATA_DIR, { recursive: true });
  const before = fs.readdirSync(ABS_DATA_DIR);
  if (before.length !== 0) fail(`${DATA_DIR} is not empty: ${before.join(', ')}`);
  say('empty — no learn.db, no config.json, no session token');

  // WHY this refuses rather than picking another port: PORT is the port the shipped app
  // listens on, so a learner's own instance answers here. Greeting that one would grade a
  // server this script never started.
  if (!(await portIsFree(PORT))) {
    fail(`port ${PORT} is already serving something — stop the running app first (or set LA_SMOKE_PORT)`);
  }

  stage('docker compose build');
  compose(['build'], { timeout: BUILD_TIMEOUT_MS });

  stage('docker compose up -d');
  compose(['up', '-d', '--force-recreate'], { timeout: BOOT_TIMEOUT_MS });

  stage(`waiting for the app on http://localhost:${PORT}`);
  const health = await waitForServer(BOOT_TIMEOUT_MS);
  say(`GET /api/health -> ${health}`);

  stage('rendering the page, which mints this launch of the app its token');
  const page = await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(60_000) });
  if (page.status !== 200) fail(`GET / returned ${page.status}`);
  const html = await page.text();
  if (!html.includes('<html')) fail('GET / did not return a document');
  say(`GET / -> 200, ${html.length} bytes`);

  const token = await readToken();
  say(`read .session-token from the host side of the bind mount (${token.slice(0, 8)}...)`);

  stage('the entrypoint printed the same line the start scripts print');
  const logs = compose(['logs', 'app'], { capture: true });
  const marker = `Open http://localhost:${PORT}`;
  if (!logs.includes(marker)) fail(`container logs never contained "${marker}"`);
  say(`found: [learn-assistant] ${marker}`);

  stage('POST /api/topics — creating a topic');
  const subject = 'Docker smoke: information theory';
  const created = await api('/api/topics', token, {
    method: 'POST',
    body: JSON.stringify({
      subject,
      level: 'intermediate',
      purpose: 'prove a fresh container can take a topic',
      runDiagnostic: false,
    }),
  });
  if (created.status !== 200 || created.body?.ok !== true) {
    fail(`POST /api/topics -> ${created.status} ${JSON.stringify(created.body).slice(0, 400)}`);
  }
  const topicId = created.body.data?.id;
  if (typeof topicId !== 'string' || topicId.length === 0) fail('the created topic came back without an id');
  if (created.body.data?.subject !== subject) fail('the created topic came back with a different subject');
  if (created.body.data?.status !== 'queued') fail(`a new topic should be queued, not ${created.body.data?.status}`);
  say(`POST /api/topics -> 200, topic ${topicId} with status "${created.body.data?.status}"`);

  stage('the topic is on the dashboard');
  const listed = await api('/api/topics', token);
  const dashboard = JSON.stringify(listed.body);
  if (listed.status !== 200 || !dashboard.includes(topicId)) {
    fail(`GET /api/topics -> ${listed.status}, topic ${topicId} not present`);
  }
  say(`GET /api/topics -> 200, ${topicId} present`);

  stage('the store landed in the host directory, not inside the container');
  const after = fs.readdirSync(ABS_DATA_DIR).sort();
  for (const wanted of ['learn.db', 'logs', 'topics']) {
    if (!after.includes(wanted)) fail(`${DATA_DIR} has no ${wanted} — got ${after.join(', ')}`);
  }
  say(`${DATA_DIR} now holds: ${after.join(', ')}`);

  stage('down, then up again — the topic survives a container it did not live in');
  compose(['down', '--remove-orphans'], { timeout: 120_000 });
  compose(['up', '-d', '--force-recreate'], { timeout: BOOT_TIMEOUT_MS });
  await waitForServer(BOOT_TIMEOUT_MS);
  await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(60_000) });
  const token2 = await readToken();
  const relisted = await api('/api/topics', token2);
  if (relisted.status !== 200 || !JSON.stringify(relisted.body).includes(topicId)) {
    fail(`after a restart, GET /api/topics -> ${relisted.status} and ${topicId} is gone`);
  }
  say(`GET /api/topics -> 200, ${topicId} still there (new token ${token2.slice(0, 8)}...)`);

  console.log(`\n[docker-smoke] PASS — empty ${DATA_DIR}, app on ${PORT}, topic created and persisted.`);
}

try {
  await main();
} catch (e) {
  console.error(`\n[docker-smoke] FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
  // WHY here: teardown removes the container, so CI's own "Container logs" step, which
  // runs after this script exits, has nothing left to print.
  if (!KEEP) {
    say('container logs:');
    spawnSync('docker', ['compose', '-p', PROJECT, 'logs', '--no-color', '--tail', '200'], {
      cwd: root,
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: 60_000,
    });
  }
} finally {
  teardown();
}
