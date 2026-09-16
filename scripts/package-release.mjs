#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

// A tag build must ship assets named for the tag. Without this, pushing v0.2.0
// without bumping package.json publishes learn-assistant-0.1.0-* and a
// SHA256SUMS.txt recording those wrong names.
const tag = process.env.GITHUB_REF_NAME;
if (tag && tag !== `v${pkg.version}`) {
  console.error(
    `release tag/version mismatch: GITHUB_REF_NAME is "${tag}" but package.json version is "${pkg.version}" (expected tag "v${pkg.version}").\n` +
      `Bump package.json to ${tag.replace(/^v/, '')} and re-tag, or tag v${pkg.version}.`,
  );
  process.exit(1);
}

const out = path.join(root, 'release');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const name = `${pkg.name}-${pkg.version}-${process.platform}-${process.arch}.tar.gz`;
const candidates = ['.next', 'public', 'package.json', 'package-lock.json', 'scripts', 'start.sh', 'start.bat', 'README.md', 'LICENSE'];
// tar exits non-zero on a missing operand, so drop absent entries rather than
// failing the whole release for an optional file.
const include = candidates.filter((entry) => existsSync(path.join(root, entry)));
const skipped = candidates.filter((entry) => !include.includes(entry));
if (skipped.length) console.log(`skipping absent entries: ${skipped.join(', ')}`);
if (!include.length) {
  console.error('nothing to package: none of the release entries exist on disk');
  process.exit(1);
}
// GNU tar reads a leading "C:" in an absolute Windows path as a remote host, so
// hand it a repo-relative, forward-slashed destination instead.
const dest = path.relative(root, path.join(out, name)).split(path.sep).join('/');
execFileSync('tar', ['-czf', dest, ...include], { cwd: root, stdio: 'inherit' });
console.log(`packaged ${name}`);
