import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

// WHY (harness safety): 31544 is the port the SHIPPED app listens on. Sharing it meant
// `reuseExistingServer` would adopt a learner's already-running app — pointed at the live
// ./data root and at the real Claude CLI — and run the whole suite against it: real
// subjects mutated, real sessions billed. The suite gets its own port and always starts
// its own server, so the only thing it can ever talk to is the one it seeded.
const PORT = Number(process.env.PORT ?? 31545);
const baseURL = `http://127.0.0.1:${PORT}`;
// WHY: webServer.command goes through a shell. On Windows that shell is cmd.exe,
// which refuses to resolve a bare `start.bat` from the cwd whenever
// NoDefaultCurrentDirectoryInExePath is set (Git Bash sets it), so the launcher
// is addressed by absolute path rather than relying on cwd resolution.
const startScript =
  process.platform === 'win32'
    ? `"${path.resolve(__dirname, 'start.bat')}"`
    : path.resolve(__dirname, 'start.sh');

/** Forwards only the vars that are actually set, so an unset one does not become ''. */
function pick(names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') out[name] = value;
  }
  return out;
}

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI === 'true',
  reporter: [['list'], ['json', { outputFile: 'e2e/.report/results.json' }]],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    extraHTTPHeaders: {},
  },
  projects: [
    {
      name: 'functional',
      // WHY `real`: e2e/real drives the actual Claude CLI and bills real sessions. It
      // shares this config so it gets the same server and fixtures, but it must never be
      // swept up by a plain `npm run e2e`. Being its own project is NOT what keeps it out:
      // a bare `playwright test` runs EVERY project, `real` included. The guard is that
      // `npm run e2e` pins `--project=functional`; `real` is opted into via `npm run e2e:real`.
      testIgnore: /(perf|uipass|walkthrough|real)[\/]/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'real',
      testMatch: /real[\/].*\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'perf',
      testMatch: /perf[\/].*\.perf\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: startScript,
    // WHY: every /api route requires the per-launch token, so readiness is probed
    // on the app's own document instead of on a route that must answer 401.
    url: `${baseURL}/`,
    // Never adopt a foreign server: the suite's isolation depends on this process owning
    // the one it talks to (see the port note above).
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PORT: String(PORT),
      LA_DATA_ROOT: process.env.LA_DATA_ROOT ?? '.e2e-data',
      LA_CLAUDE_BIN:
        process.env.LA_CLAUDE_BIN ??
        path.resolve(
          'e2e/fixtures',
          process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude.sh',
        ),
      // WHY forwarded rather than fixed: the default suite runs against the fake CLI, but
      // e2e/real drives a real provider, and which one is a choice made at the command
      // line. Only the vars that are set are passed on, so the default stays untouched.
      ...pick(['LA_PROVIDER', 'LA_LLAMA_BIN', 'LA_LLAMA_MODEL', 'LA_LLAMA_URL', 'LA_OLLAMA_MODEL']),
    },
  },
});
