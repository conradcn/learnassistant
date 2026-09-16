#!/usr/bin/env node
// WHY this exists: `npm run dev` is the one entry point CI never ran, and it was broken on
// Windows for as long as the script carried POSIX `${PORT:-31544}` expansion — npm hands
// scripts to cmd.exe, which passes that string through literally and Next rejects it as a
// port. Nothing else in the battery starts the dev server, so only a check that actually
// launches it can keep the regression from coming back. It proves the narrow thing that
// failed: the server comes up and binds the port it was told to.
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Not 31544: a dev server or a Playwright run may already hold the project's own port.
const port = process.env.LA_DEV_SMOKE_PORT ?? '31547';
const timeoutMs = 180_000;

const child = spawn(process.execPath, [path.join(root, 'scripts', 'dev.mjs')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PORT: port },
});

let exited = null;
child.on('exit', (code, signal) => {
  exited = signal ?? code;
});

const listening = () =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });

const finish = (ok, message) => {
  console.log(`[dev-smoke] ${message}`);
  child.kill();
  process.exit(ok ? 0 : 1);
};

const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  if (exited !== null) {
    finish(false, `the dev server exited (${exited}) before it listened on ${port}`);
  }
  if (await listening()) {
    finish(true, `the dev server is listening on ${port}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
finish(false, `the dev server did not listen on ${port} within ${timeoutMs / 1000}s`);
