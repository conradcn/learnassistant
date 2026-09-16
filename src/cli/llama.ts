// FRACTAL: implements F6 | component C2
/**
 * A local llama.cpp server standing in for the Claude CLI.
 *
 * WHY a second local provider rather than one: Ollama is a daemon that owns a model
 * store and is either running or not; llama-server is a plain executable that serves
 * one model file named on its command line. That difference is the whole feature —
 * because the app knows the binary and the model file, it can START the server itself,
 * so choosing a local model is not also a chore of remembering to launch something in
 * another terminal first.
 *
 * Like the Ollama transport, this is a CliTransport whose stdout imitates the CLI's
 * `--output-format json` envelope, so the stall timer, hard timeout, cancellation,
 * output cap, JSON unwrap and schema check in SessionRunner all apply unchanged.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadConfig } from '@/core/config';
import { log } from '@/core/log';
import type { CliChildHandle, CliTransport, SpawnOptions } from './run-session';
import { splitPrompt, type ChatMessage } from './chat';

export type LlamaSettings = { baseUrl: string; binPath: string; modelPath: string };

// WHY low: llama-server honours OpenAI's `reasoning_effort`, and a reasoning model left
// on its default spends minutes deliberating over a prompt whose answer the output
// contract already pins down. On local hardware that deliberation is the whole cost of
// the session. A server whose model has no reasoning mode ignores the field.
const REASONING_EFFORT = 'low';

const HEALTH_TIMEOUT_MS = 2_000;
// WHY this long: the first health check after a spawn is answered only once the whole
// model is resident, which for a multi-gigabyte file on a cold page cache is minutes,
// not seconds. Giving up early would report "did not start" for a server that then
// comes up seconds later and is never used.
const START_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 500;

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

async function isServing(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(endpoint(baseUrl, '/health'), {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function portOf(baseUrl: string): string {
  const url = new URL(baseUrl);
  return url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port;
}

function hostOf(baseUrl: string): string {
  return new URL(baseUrl).hostname;
}

export type StartOutcome = { ok: true; started: boolean } | { ok: false; message: string };

/**
 * Makes sure a llama-server is answering at the configured address, starting one if it
 * is not. Returns `started: false` when a server was already there — an already-running
 * server (the learner's own, or one left from an earlier session) is used as-is rather
 * than duplicated onto a port that is taken.
 *
 * WHY the child is detached and unref'd on every platform: a model that took two minutes
 * to load should survive the app restarting, and the app is not the server's owner in any
 * sense that would make killing it on exit correct. On Windows this is not cosmetic —
 * without `detached` the server is torn down with the parent's console, so a server the
 * app started was killed mid-load by the first restart and never once answered.
 */
// WHY an in-flight map: the Settings screen probes on load AND on save, and a session
// can dispatch while both are outstanding. Each would otherwise spawn its own server for
// the same address — the loser of the bind race just exits, but not before a second copy
// of a multi-gigabyte model has started loading into the same GPU.
const starting = new Map<string, Promise<StartOutcome>>();

export function ensureLlamaServer(settings: LlamaSettings): Promise<StartOutcome> {
  const inFlight = starting.get(settings.baseUrl);
  if (inFlight !== undefined) return inFlight;
  const attempt = startServer(settings).finally(() => starting.delete(settings.baseUrl));
  starting.set(settings.baseUrl, attempt);
  return attempt;
}

async function startServer(settings: LlamaSettings): Promise<StartOutcome> {
  if (await isServing(settings.baseUrl)) return { ok: true, started: false };
  if (settings.modelPath.trim().length === 0) {
    return { ok: false, message: 'No llama.cpp model file is set. Choose a .gguf file in Settings.' };
  }
  if (!existsSync(settings.modelPath)) {
    return { ok: false, message: `No model file at ${settings.modelPath}.` };
  }

  const argv = [
    '-m',
    settings.modelPath,
    '--host',
    hostOf(settings.baseUrl),
    '--port',
    portOf(settings.baseUrl),
    // WHY -ngl 99: offload every layer it can. llama.cpp silently runs on the CPU
    // otherwise, which turns a 30-second lesson into a 20-minute one on a machine that
    // has a GPU sitting idle. A machine without one ignores it.
    '-ngl',
    '99',
    '-c',
    '8192',
    // WHY --jinja: the chat template travels inside the .gguf, and without this flag
    // llama-server substitutes a generic one — which is how a model that follows an
    // output contract perfectly under Ollama returns prose here.
    '--jinja',
  ];

  let child;
  try {
    child = spawn(settings.binPath, argv, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    return { ok: false, message: `Could not start llama-server from ${settings.binPath}.` };
  }
  let spawnFailure: string | null = null;
  child.on('error', (e: NodeJS.ErrnoException) => {
    spawnFailure =
      e.code === 'ENOENT'
        ? `No llama-server executable at ${settings.binPath}.`
        : `llama-server could not be started: ${e.message}`;
  });
  child.unref();
  log({ level: 'info', event: 'llama-server-starting', component: 'C2', pid: child.pid ?? 0 });

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnFailure !== null) return { ok: false, message: spawnFailure };
    if (child.exitCode !== null && !(await isServing(settings.baseUrl))) {
      return { ok: false, message: `llama-server exited immediately (code ${child.exitCode}).` };
    }
    if (await isServing(settings.baseUrl)) {
      log({ level: 'info', event: 'llama-server-ready', component: 'C2', pid: child.pid ?? 0 });
      return { ok: true, started: true };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { ok: false, message: `llama-server did not answer at ${settings.baseUrl} in time.` };
}

class LlamaChildHandle implements CliChildHandle {
  // WHY: there is no child process of ours here, but SessionRunner logs and cancels by
  // handle and reads `undefined` as "spawn failed". A sentinel keeps that honest.
  readonly pid = 0;
  private buffer = '';
  private settled = false;
  private readonly controller = new AbortController();
  private readonly stdoutCbs: ((chunk: Buffer) => void)[] = [];
  private readonly exitCbs: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  private readonly errorCbs: ((e: Error) => void)[] = [];

  constructor(private readonly settings: LlamaSettings) {}

  write(data: string): void {
    this.buffer += data;
  }

  endStdin(): void {
    void this.ask();
  }

  private async ask(): Promise<void> {
    let text: string;
    try {
      const started = await ensureLlamaServer(this.settings);
      if (!started.ok) {
        this.fail(started.message);
        return;
      }
      if (this.controller.signal.aborted) return;
      const response = await this.post(splitPrompt(this.buffer));
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 400);
        this.fail(`llama.cpp answered ${response.status}${detail === '' ? '' : `: ${detail}`}`);
        return;
      }
      const collected = await this.collect(response);
      if (collected === null) return;
      text = collected;
    } catch (e) {
      if (this.controller.signal.aborted) return;
      this.fail(e instanceof Error ? e.message : String(e));
      return;
    }
    this.emit({ type: 'result', is_error: false, result: text });
    this.finish(0, null);
  }

  private post(messages: ChatMessage[]): Promise<Response> {
    const body = {
      messages,
      // WHY streaming: a non-streamed reply sends no response headers until the whole
      // generation is done, and Node's fetch abandons a header-less response after five
      // minutes. A local model routinely takes longer than that.
      stream: true,
      // WHY: the output contracts ask for exactly one JSON object, and llama.cpp
      // constrains decoding to valid JSON for this format — which is what makes a small
      // local model usable here at all.
      response_format: { type: 'json_object' },
      reasoning_effort: REASONING_EFFORT,
      temperature: 0.2,
    };
    return fetch(endpoint(this.settings.baseUrl, '/v1/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.controller.signal,
    });
  }

  /**
   * Reassembles the server-sent-event stream into the single answer the envelope
   * carries. Returns null when a failure has already been reported.
   */
  private async collect(response: Response): Promise<string | null> {
    if (response.body === null) {
      this.fail('llama.cpp returned no response body.');
      return null;
    }
    const decoder = new TextDecoder();
    let pending = '';
    let text = '';
    let failed = false;
    const take = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const payload = trimmed.slice('data:'.length).trim();
      if (payload === '' || payload === '[DONE]') return;
      let frame: { choices?: { delta?: { content?: unknown } }[]; error?: { message?: unknown } };
      try {
        frame = JSON.parse(payload) as typeof frame;
      } catch {
        // WHY tolerated: a partial frame is normal mid-stream and is flushed at the end.
        return;
      }
      if (frame.error !== undefined) {
        const message = typeof frame.error.message === 'string' ? frame.error.message : 'unknown error';
        this.fail(`llama.cpp reported an error: ${message}`);
        failed = true;
        return;
      }
      const delta = frame.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') text += delta;
    };

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        take(line);
        if (failed) return null;
      }
    }
    take(pending);
    if (failed) return null;
    if (text === '') {
      this.fail('llama.cpp returned no message content.');
      return null;
    }
    return text;
  }

  /** WHY: a failure is reported as a non-zero exit with the reason on stdout, because
   *  that is the shape SessionRunner already turns into a logged `nonzero-exit` with a
   *  readable excerpt. Inventing a new failure channel would bypass that logging. */
  private fail(reason: string): void {
    if (this.settled) return;
    this.emit({ type: 'result', is_error: true, result: reason });
    this.finish(1, null);
  }

  private emit(payload: unknown): void {
    const line = `${JSON.stringify(payload)}\n`;
    for (const cb of this.stdoutCbs) cb(Buffer.from(line, 'utf8'));
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.settled) return;
    this.settled = true;
    for (const cb of this.exitCbs) cb(code, signal);
  }

  onStdout(cb: (chunk: Buffer) => void): void {
    this.stdoutCbs.push(cb);
  }

  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitCbs.push(cb);
  }

  onError(cb: (e: Error) => void): void {
    this.errorCbs.push(cb);
  }

  // WHY only the request is abandoned: the server is shared and long-lived, and a
  // cancelled session must not take the next one's model out of memory with it.
  kill(signal: NodeJS.Signals): void {
    this.controller.abort();
    this.finish(null, signal);
  }
}

export class LlamaTransport implements CliTransport {
  constructor(private readonly settings?: LlamaSettings) {}

  spawn(_bin: string, _argv: string[], _opts: SpawnOptions): CliChildHandle {
    const config = loadConfig();
    return new LlamaChildHandle(this.settings ?? config.llama);
  }
}

export type LlamaAvailability =
  | { ok: true; version: string }
  | { ok: false; reason: 'missing' | 'unusable'; message: string };

/**
 * Answers the same question `checkClaudeAvailable` does: can a session actually run?
 *
 * WHY `start` is a parameter and not always true: with the binary and the model file
 * both known, "not running" is not a state the learner has to do anything about, so the
 * Settings screen — where they chose this provider and are waiting for an answer — asks
 * for it to be started. The health panel polls, and a poll that can block for minutes
 * loading a model is a hung status bar; it asks the same question without the starting.
 */
export async function checkLlamaAvailable(start = false, override?: LlamaSettings): Promise<LlamaAvailability> {
  const settings = override ?? loadConfig().llama;
  const missingModel = settings.modelPath.trim().length === 0 || !existsSync(settings.modelPath);
  if (!start) {
    if (missingModel) {
      return {
        ok: false,
        reason: 'missing',
        message:
          settings.modelPath.trim().length === 0
            ? 'No llama.cpp model file is set. Choose a .gguf file in Settings.'
            : `No model file at ${settings.modelPath}.`,
      };
    }
    if (!(await isServing(settings.baseUrl))) {
      return {
        ok: false,
        reason: 'unusable',
        message: `No llama.cpp server is running yet at ${settings.baseUrl}; it starts with the next session.`,
      };
    }
  } else {
    const started = await ensureLlamaServer(settings);
    if (!started.ok) {
      return { ok: false, reason: missingModel ? 'missing' : 'unusable', message: started.message };
    }
  }
  const name = settings.modelPath.split(/[\\/]/).pop() ?? settings.modelPath;
  return { ok: true, version: `llama.cpp · ${name}` };
}
