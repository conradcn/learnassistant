#!/usr/bin/env node
// WHY this is a script and not `next dev -p ${PORT:-31544}`: npm runs scripts through
// cmd.exe on Windows, which does not expand `${PORT:-31544}`. Next received that literal
// string as its port and died before serving anything, so the whole edit-reload loop was
// Linux-only. The default lives in JS instead, and Next is launched through this process's
// own node binary — no shell, so no quoting rules to differ between platforms.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// fileURLToPath, not `new URL(...).pathname`: the latter leaves the path percent-encoded, so
// a checkout under a directory with a space in its name resolves to a root that does not exist.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.PORT ?? '31544';

const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '-p', port], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

child.on('error', (error) => {
  console.error(`[learn-assistant] Could not start the dev server: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(signal !== null ? 1 : (code ?? 0));
});
