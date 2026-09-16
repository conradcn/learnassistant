// FRACTAL: implements F6 | component C2
/**
 * The machinery every provider that talks HTTP rather than spawning the Claude CLI shares.
 *
 * WHY it exists: a `CliTransport` for a chat API is about fifty lines of bookkeeping —
 * pretending to be a child process for SessionRunner's benefit, buffering the prompt until
 * stdin closes, reporting a failure as a non-zero exit with the reason on stdout — and
 * about ten lines of "what this vendor's wire format looks like". Written per provider,
 * the fifty lines get copied seven times and the ten that matter get lost in them. Here,
 * a provider is a `label` and an `ask()`; everything else is inherited and identical.
 *
 * WHY the stdout it emits imitates the CLI's `--output-format json` envelope
 * (`{type:'result', result:"<text>"}`): SessionRunner already owns the stall timer, the
 * hard timeout, cancellation, the 1MB output cap, the JSON unwrap (including recovery of
 * an answer wrapped in a ``` fence) and the schema check. A second output format would be
 * a second copy of all of that.
 */
import type { CliChildHandle } from './run-session';
import { splitPrompt, systemPromptOf, type ChatMessage } from './chat';

/** Joins a configured base URL to a path without doubling or dropping the separator. */
export function endpointOf(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/** WHY bounded: a failing endpoint's body can be an HTML error page megabytes long, and
 *  this text ends up in a log line and a learner-facing message. */
export function excerpt(detail: string): string {
  const trimmed = detail.trim();
  return trimmed.length === 0 ? '' : `: ${trimmed.slice(0, 400)}`;
}

/** The body of a failed response, or '' when it cannot be read. */
export async function peekBody(response: Response): Promise<string> {
  return response.text().catch(() => '');
}

/**
 * Walks a `text/event-stream` body line by line, handing each `data:` payload to `take`.
 *
 * WHY streaming everywhere and not just where a provider requires it: a non-streamed
 * generation sends no response headers until the whole answer is finished, and Node's
 * fetch abandons a header-less response after five minutes (UND_ERR_HEADERS_TIMEOUT).
 * A long lesson from a slow model died in the HTTP client rather than at any budget this
 * app set. Streaming makes the headers arrive at once and keeps the socket fed.
 */
export async function readEventStream(
  response: Response,
  take: (payload: string) => void,
): Promise<void> {
  if (response.body === null) throw new Error('the response had no body.');
  const decoder = new TextDecoder();
  let pending = '';
  const line = (raw: string): void => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice('data:'.length).trim();
    if (payload === '' || payload === '[DONE]') return;
    take(payload);
  };
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const l of lines) line(l);
  }
  line(pending);
}

/**
 * A session handle for a provider reached over HTTP.
 *
 * A subclass supplies two things: what to call this provider when something goes wrong,
 * and how to turn one system/user pair into one answer.
 */
export abstract class HttpChildHandle implements CliChildHandle {
  // WHY a sentinel and not `undefined`: there is no child process here, but SessionRunner
  // logs and cancels by handle and reads an undefined pid as "the spawn failed".
  readonly pid = 0;
  private prompt = '';
  private settled = false;
  protected readonly controller = new AbortController();
  private readonly stdoutCbs: ((chunk: Buffer) => void)[] = [];
  private readonly exitCbs: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  private readonly errorCbs: ((e: Error) => void)[] = [];

  /** WHY the argv: it carries the `--system-prompt` SessionRunner gives the CLI, which is
   *  what tells this session whether it is authoring or tutoring. Taking it in the base
   *  is what makes that true of every HTTP provider without one of them remembering to. */
  constructor(private readonly argv: readonly string[]) {}

  /** How this provider is named in a message a learner reads. */
  protected abstract readonly label: string;

  /** One turn: the prompt as system/user messages in, the model's answer out. */
  protected abstract ask(messages: ChatMessage[]): Promise<string>;

  write(data: string): void {
    this.prompt += data;
  }

  endStdin(): void {
    void this.run();
  }

  private async run(): Promise<void> {
    let text: string;
    try {
      text = await this.ask(splitPrompt(this.prompt, systemPromptOf(this.argv)));
    } catch (e) {
      // WHY a cancelled request reports nothing: SessionRunner's own kill path has
      // already settled the session, and a second finish would race it.
      if (this.controller.signal.aborted) return;
      this.fail(e instanceof Error ? e.message : String(e));
      return;
    }
    if (this.controller.signal.aborted) return;
    if (text.trim() === '') {
      this.fail(`${this.label} returned no message content.`);
      return;
    }
    this.emit({ type: 'result', is_error: false, result: text });
    this.finish(0, null);
  }

  /** WHY a failure is a non-zero exit with the reason on stdout: that is the shape
   *  SessionRunner already turns into a logged `nonzero-exit` with a readable excerpt.
   *  A separate failure channel would bypass that logging. */
  protected fail(reason: string): void {
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

  /** WHY only the request is abandoned: a hosted endpoint and a local inference server
   *  are both shared and long-lived, and a cancelled session must not take the next
   *  one's model down with it. */
  kill(signal: NodeJS.Signals): void {
    this.controller.abort();
    this.finish(null, signal);
  }
}
