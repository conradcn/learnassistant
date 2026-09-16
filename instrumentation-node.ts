// FRACTAL: implements (none) | component C0
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * WHY: the server process died with no JavaScript stack trace and an exit code of -1
 * while the background job pump was draining its first live job. Nothing in the repo
 * registered a single process-level handler, so a fire-and-forget rejection or a hard
 * `uncaughtException` left no trace at all. `register()` runs once per server process,
 * which is the only genuinely process-scoped hook this app has.
 *
 * WHY no `import { log } from '@/core/log'`: instrumentation is compiled into its own
 * webpack layer. Importing anything from `src/` puts shared modules into a chunk the
 * instrumentation runtime cannot resolve at load — the build comes up and then answers
 * every route with `Cannot find module './<id>.js'`. A crash handler that depends on the
 * module graph is also exactly the handler that will not run when the module graph is
 * what failed, so this writes the same ndjson line to the same file with no imports
 * beyond `node:fs`.
 */

function logsDir(): string {
  const configured = process.env.LA_DATA_ROOT?.trim();
  return path.join(path.resolve(configured !== undefined && configured.length > 0 ? configured : 'data'), 'logs');
}

function todayFileName(): string {
  const now = new Date();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `app-${now.getUTCFullYear()}-${m}-${d}.ndjson`;
}

function emit(entry: Record<string, unknown>): void {
  const line = JSON.stringify({ component: 'C0', ...entry });
  try {
    const dir = logsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, todayFileName()), `${line}\n`);
  } catch {
    // the sink is unwritable; stderr below is the whole remaining budget
  }
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // stderr is closed — nothing further is possible
  }
}

function describe(e: unknown): Record<string, unknown> {
  return e instanceof Error
    ? { errName: e.name, cause: e.message, stack: e.stack ?? null }
    : { errName: typeof e, cause: String(e), stack: null };
}

export function register(): void {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const host = globalThis as { __laProcessHandlers?: boolean };
  if (host.__laProcessHandlers === true) return;
  host.__laProcessHandlers = true;

  process.on('uncaughtException', (e, origin) => {
    emit({ level: 'error', event: 'process-uncaught-exception', origin, ...describe(e) });
  });

  process.on('unhandledRejection', (reason) => {
    emit({ level: 'error', event: 'process-unhandled-rejection', ...describe(reason) });
  });

  process.on('beforeExit', (code) => {
    emit({ level: 'info', event: 'process-before-exit', code });
  });

  // WHY: `exit` handlers must be synchronous, which appendFileSync is. This is the
  // line that would have named the cause of the silent death.
  process.on('exit', (code) => {
    emit({ level: 'info', event: 'process-exit', code });
  });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.on(signal, () => {
      emit({ level: 'warn', event: 'process-signal', signal });
      process.exit(0);
    });
  }

  emit({ level: 'info', event: 'process-handlers-installed', pid: process.pid });
}
