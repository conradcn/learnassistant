// FRACTAL: covers project | type smoke | targets Dockerfile,docker-compose.yml,.dockerignore
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { START_PORT as PORT } from '../fixtures/app-constants';

const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
const dockerignore = fs.readFileSync('.dockerignore', 'utf8');
const compose = fs.readFileSync('docker-compose.yml', 'utf8');
const entrypoint = fs.readFileSync('docker/entrypoint.sh', 'utf8');
const readme = fs.readFileSync('README.md', 'utf8');
const envExample = fs.readFileSync('.env.example', 'utf8');

// WHY these are text assertions and not a parsed compose document: the repo has no YAML
// parser, `docker compose config` needs a daemon, and this must stay a test that runs on
// any machine in milliseconds. The live behaviour is checked further down, by running it.
function line(haystack: string, needle: string): boolean {
  return haystack.split('\n').some((l) => l.trim() === needle);
}

describe('Dockerfile contract', () => {
  it('is a multi-stage build on the node version .nvmrc pins', () => {
    const nvmrc = fs.readFileSync('.nvmrc', 'utf8').trim();
    expect(dockerfile).toContain(`ARG NODE_VERSION=${nvmrc}`);
    const stages = [...dockerfile.matchAll(/^FROM .+ AS (\S+)$/gm)].map((m) => m[1]);
    expect(stages).toEqual(['deps', 'build', 'runtime']);
    // The runtime layer takes its node_modules from the production-only install and its
    // .next from the build — it carries neither a dev dependency nor a compiler.
    expect(dockerfile).toContain('RUN npm ci --omit=dev');
    expect(dockerfile).toMatch(/COPY --from=deps\s+--chown=node:node \/app\/node_modules/);
    expect(dockerfile).toMatch(/COPY --from=build --chown=node:node \/app\/\.next/);
  });

  it('produces a production build and serves it without rebuilding', () => {
    expect(dockerfile).toContain('NODE_ENV=production');
    expect(dockerfile).toContain('RUN npm run build');
    // WHY the negative: `npm run start` is scripts/start.mjs, which rebuilds when it sees
    // sources newer than .next. In a runtime layer with no dev dependencies that rebuild
    // cannot succeed, so the container must go straight to `next start`.
    expect(entrypoint).toContain('next start');
    expect(entrypoint).not.toContain('npm run start');
    expect(entrypoint).not.toContain('npm run build');
    // and it says to the user what start.sh and start.bat say
    expect(entrypoint).toContain('Open http://localhost:');
    expect(entrypoint).not.toContain('\r\n');
  });

  it('runs as a non-root user', () => {
    const users = [...dockerfile.matchAll(/^USER (\S+)$/gm)].map((m) => m[1]);
    expect(users.at(-1)).toBe('node');
    // the data root has to belong to that user or the first write fails
    expect(dockerfile).toContain('chown -R node:node /app/data /home/node');
    expect(line(compose, 'user: "${LA_UID:-1000}:${LA_GID:-1000}"')).toBe(true);
  });

  it('keeps host build output, learner data and logs out of the build context', () => {
    for (const pattern of [
      'node_modules/',
      '.next/',
      'data/',
      'test-results/',
      'server.log',
      'server.err.log',
      '*.ndjson',
      '.env',
      '!.env.example',
    ]) {
      expect(line(dockerignore, pattern), `${pattern} should be in .dockerignore`).toBe(true);
    }
  });
});

describe('docker-compose contract', () => {
  it('publishes the project port on both sides and tells the container to use it', () => {
    // WHY both sides must match: the app refuses any request whose Host header is not
    // loopback on its own port, so an asymmetric mapping is a 401 on every request.
    expect(line(compose, `- "\${PORT:-${PORT}}:\${PORT:-${PORT}}"`)).toBe(true);
    expect(line(compose, `PORT: \${PORT:-${PORT}}`)).toBe(true);
  });

  it('bind-mounts ./data so the store, module directories and logs survive a rebuild', () => {
    expect(line(compose, '- ${LA_DATA_DIR:-./data}:/app/data')).toBe(true);
    expect(line(compose, 'LA_DATA_ROOT: /app/data')).toBe(true);
  });

  it('reads .env for configuration without requiring one to exist', () => {
    expect(compose).toContain('env_file:');
    expect(line(compose, '- path: .env')).toBe(true);
    expect(line(compose, 'required: false')).toBe(true);
  });

  it('points every host-side provider away from the container loopback', () => {
    // 127.0.0.1 inside a container is the container. Every provider that runs on the
    // learner's machine has to be re-pointed, not just Ollama.
    for (const key of ['LA_OLLAMA_URL', 'LA_LLAMA_URL', 'LA_OPENAI_COMPAT_URL', 'LA_CHAT_LLAMA_URL']) {
      const row = compose.split('\n').find((l) => l.trim().startsWith(`${key}:`));
      expect(row, `${key} should be set for the container`).toBeDefined();
      expect(row, key).toContain('host.docker.internal');
      expect(row, key).not.toContain('127.0.0.1');
    }
    // host.docker.internal is not a name Linux resolves on its own.
    expect(line(compose, '- "host.docker.internal:host-gateway"')).toBe(true);
    // and the README has to name the address, since it is the whole fix
    expect(readme).toContain('host.docker.internal:11434');
    expect(readme).toContain('OLLAMA_HOST=0.0.0.0');
  });

  it('leaves the claude CLI out of the image unless it is asked for, and says so', () => {
    expect(line(compose, 'INSTALL_CLAUDE_CLI: ${LA_INSTALL_CLAUDE_CLI:-false}')).toBe(true);
    expect(dockerfile).toContain('ARG INSTALL_CLAUDE_CLI=false');
    // The entrypoint must say plainly, at boot, that the default provider cannot run here.
    expect(entrypoint).toContain('claude CLI is NOT in this container');
    // WHY the README and .env.example are asserted from a test: "what the Docker user gets
    // by default" is the part of this that is documentation and nothing else, so nothing
    // but a test keeps it from drifting away from the container it describes.
    expect(readme).toContain('The `claude` CLI in a container');
    expect(readme).toContain('LA_INSTALL_CLAUDE_CLI');
    expect(envExample).toContain('LA_INSTALL_CLAUDE_CLI');
    expect(envExample).toContain('LA_CLAUDE_HOME');
    expect(envExample).toContain('LA_DATA_DIR');
    expect(envExample).toContain('LA_UID');
  });
});

// The live half. It builds an image and runs a container, so it is opt-in — CI sets
// LA_DOCKER_SMOKE=1 on the one job that has a docker daemon.
describe('docker fresh start', () => {
  it.skipIf(process.env.LA_DOCKER_SMOKE !== '1')(
    'comes up on an empty data directory and takes a topic',
    { timeout: 30 * 60_000 },
    async () => {
      // WHY not spawnSync: this runs for minutes, and a synchronous child blocks the
      // worker's event loop for all of them — vitest's own progress RPC then times out
      // and the run reports an unhandled error beside a passing test.
      const { status, output } = await new Promise<{ status: number | null; output: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [path.join('scripts', 'docker-smoke.mjs')], {
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 29 * 60_000,
        });
        let text = '';
        child.stdout.on('data', (b: Buffer) => (text += b.toString('utf8')));
        child.stderr.on('data', (b: Buffer) => (text += b.toString('utf8')));
        child.on('error', reject);
        child.on('close', (code) => resolve({ status: code, output: text }));
      });
      expect(output, output.slice(-4000)).toContain('[docker-smoke] PASS');
      expect(status, output.slice(-4000)).toBe(0);
    },
  );
});
