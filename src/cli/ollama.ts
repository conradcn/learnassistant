// FRACTAL: implements F6 | component C2
/**
 * A local Ollama server standing in for the Claude CLI.
 *
 * WHY it is a CliTransport rather than a second code path: every session already goes
 * through SessionRunner, which owns the stall timer, the hard timeout, cancellation,
 * the output-size cap, the JSON unwrap and the schema check. Ollama differs only in
 * how the prompt travels and where the answer comes from, so it is implemented as
 * another handle whose stdout is shaped like the CLI's own `--output-format json`
 * envelope ({type:'result', result:"<text>"}). Everything downstream is untouched,
 * which is also why an Ollama answer wrapped in a ```json fence is recovered by the
 * same jsonCandidates() reader as a Claude one.
 *
 * The prompts in src/cli/prompt.ts ask for one JSON object and explicitly say to write
 * no files, so nothing that reaches here needs tools or filesystem access — which is
 * the reason a tool-less local model is a usable provider at all.
 */
import { loadConfig } from '@/core/config';
import type { CliChildHandle, CliTransport, SpawnOptions } from './run-session';
import { splitPrompt, type ChatMessage } from './chat';

export type OllamaSettings = { baseUrl: string; model: string };

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

// WHY low and not the model's default: a reasoning model left on its default effort
// spends minutes deliberating over a lesson-authoring prompt whose answer is already
// fully specified by the output contract — the thinking is not what makes the answer
// good here, and on local hardware it is the whole cost of the session. Low effort is
// what makes a thinking model finish a turn in a time a learner will wait through.
const REASONING_EFFORT = 'low';

/** WHY only a substring match: the wording differs by Ollama version, but every
 *  refusal of an unsupported `think` names thinking. Anything else is a real 400. */
function rejectsThinking(detail: string): boolean {
  return /think/i.test(detail);
}

async function peek(response: Response): Promise<string> {
  return response.text().catch(() => '');
}

class OllamaChildHandle implements CliChildHandle {
  // WHY: there is no child process, but SessionRunner logs and cancels by handle, and
  // a pid of `undefined` is its "spawn failed" shape. A sentinel keeps that honest.
  readonly pid = 0;
  private buffer = '';
  private settled = false;
  private readonly controller = new AbortController();
  private readonly stdoutCbs: ((chunk: Buffer) => void)[] = [];
  private readonly exitCbs: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  private readonly errorCbs: ((e: Error) => void)[] = [];

  constructor(private readonly settings: OllamaSettings) {}

  write(data: string): void {
    this.buffer += data;
  }

  endStdin(): void {
    void this.ask();
  }

  private async ask(): Promise<void> {
    const messages = splitPrompt(this.buffer);
    let text: string;
    try {
      let response = await this.post(messages, REASONING_EFFORT);
      // WHY the retry: `think` is rejected outright by a model with no reasoning mode
      // (llama3.1, most 7B chat models), and accepted only as a level by the ones that
      // have graded effort. Asking first and falling back keeps one code path for both
      // families instead of a table of which local model supports what.
      let detail = response.ok ? '' : await peek(response);
      if (response.status === 400 && rejectsThinking(detail)) {
        response = await this.post(messages, null);
        detail = response.ok ? '' : await peek(response);
      }
      if (!response.ok) {
        const excerpt = detail.slice(0, 400);
        this.fail(`Ollama answered ${response.status}${excerpt === '' ? '' : `: ${excerpt}`}`);
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

  private post(messages: ChatMessage[], think: string | null): Promise<Response> {
    const body = {
      model: this.settings.model,
      // WHY streaming, when the answer is only emitted once at the end anyway: with
      // `stream: false` Ollama sends no response headers until the whole generation is
      // finished, and Node's fetch gives up on a header-less response after five
      // minutes (UND_ERR_HEADERS_TIMEOUT). A local model on consumer hardware routinely
      // exceeds that, so every long session died in the HTTP client rather than at any
      // budget this app set. Streaming makes headers arrive at once and keeps the socket
      // fed; the chunks are reassembled below.
      stream: true,
      messages,
      // WHY: the output contracts ask for exactly one JSON object. Ollama's JSON mode
      // constrains decoding to valid JSON, which is what makes a small local model
      // usable here at all — without it the answer arrives wrapped in an apology.
      format: 'json',
      options: { temperature: 0.2 },
      ...(think === null ? {} : { think }),
    };
    return fetch(endpoint(this.settings.baseUrl, '/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.controller.signal,
    });
  }

  /**
   * Reassembles Ollama's NDJSON stream into the single answer the envelope carries.
   * Returns null when it has already reported a failure, so the caller just stops.
   */
  private async collect(response: Response): Promise<string | null> {
    if (response.body === null) {
      this.fail('Ollama returned no response body.');
      return null;
    }
    const decoder = new TextDecoder();
    let pending = '';
    let text = '';
    const take = (line: string): boolean => {
      const trimmed = line.trim();
      if (trimmed === '') return true;
      let frame: { message?: { content?: unknown }; error?: unknown };
      try {
        frame = JSON.parse(trimmed) as typeof frame;
      } catch {
        // WHY tolerated: a partial line is normal mid-stream and is flushed at the end.
        return true;
      }
      if (typeof frame.error === 'string') {
        this.fail(`Ollama reported an error: ${frame.error}`);
        return false;
      }
      const content = frame.message?.content;
      if (typeof content === 'string') text += content;
      return true;
    };

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!take(line)) return null;
      }
    }
    if (!take(pending)) return null;
    if (text === '') {
      this.fail('Ollama returned no message content.');
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

  kill(signal: NodeJS.Signals): void {
    this.controller.abort();
    this.finish(null, signal);
  }
}

export class OllamaTransport implements CliTransport {
  constructor(private readonly settings?: OllamaSettings) {}

  spawn(_bin: string, _argv: string[], _opts: SpawnOptions): CliChildHandle {
    const config = loadConfig();
    return new OllamaChildHandle(this.settings ?? config.ollama);
  }
}

export type OllamaAvailability =
  | { ok: true; version: string }
  | { ok: false; reason: 'missing' | 'unusable'; message: string };

const PROBE_TIMEOUT_MS = 5000;

/**
 * Answers the same question `checkClaudeAvailable` does: can a session actually run?
 * `settings` names which model to ask about, because lesson planning and chat can be two
 * different ones; without it the configured planning model is checked.
 * For Ollama that means the server answers AND the configured model is pulled — a
 * reachable server with no such model fails every session at dispatch time instead,
 * which is exactly the surprise this probe exists to prevent.
 */
export async function checkOllamaAvailable(settings?: OllamaSettings): Promise<OllamaAvailability> {
  const { baseUrl, model } = settings ?? loadConfig().ollama;
  let names: string[];
  try {
    const response = await fetch(endpoint(baseUrl, '/api/tags'), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, reason: 'unusable', message: `Ollama answered ${response.status} at ${baseUrl}.` };
    }
    const parsed = (await response.json()) as { models?: { name?: unknown }[] };
    names = Array.isArray(parsed.models)
      ? parsed.models.map((m) => (typeof m.name === 'string' ? m.name : '')).filter((n) => n.length > 0)
      : [];
  } catch {
    return {
      ok: false,
      reason: 'missing',
      message: `No Ollama server answered at ${baseUrl}. Start it with \`ollama serve\`.`,
    };
  }
  // WHY the match is exact except for an untagged name: `ollama pull llama3.1` installs
  // it as `llama3.1:latest`, so a config naming the bare model must still count as
  // installed. Comparing only the part before the colon was too generous in the other
  // direction — `qwen3.8:4090-27b` matched an installed `qwen3.8:latest`, so Settings
  // reported Ready for a tag /api/chat then answered 404 on, once per session.
  const installed = names.some((n) => n === model || (!model.includes(':') && n.split(':')[0] === model));
  if (!installed) {
    return {
      ok: false,
      reason: 'unusable',
      message: `Ollama is running but "${model}" is not installed. Run \`ollama pull ${model}\`.`,
    };
  }
  return { ok: true, version: `ollama · ${model}` };
}
