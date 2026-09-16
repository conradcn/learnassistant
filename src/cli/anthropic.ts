// FRACTAL: implements F6 | component C2
/**
 * Anthropic's API, dialled directly instead of through the `claude` CLI.
 *
 * WHY it exists alongside the CLI provider: the CLI is an excellent default for someone
 * who already has it installed and signed in, and a wall for everyone else — it is a
 * second install, a second login, and a PATH entry the app cannot create. A learner who
 * has an API key should not have to acquire a command-line tool to spend it.
 *
 * WHY the official SDK and not raw fetch, when every other hosted adapter here is raw
 * fetch: the SDK owns retries, the streaming reassembly, typed errors and the auth header
 * for the one vendor whose surface this app is most likely to be held to. The others speak
 * a wire format simple enough that a dependency per vendor would cost more than it saves.
 *
 * WHY no `thinking` and no `output_config.effort` are sent: the model id here is a text
 * box a learner can type anything into, and those parameters are accepted, ignored or
 * rejected outright depending on which id they typed. Sending neither means every model
 * Anthropic offers runs on its own defaults — which on the current generation is adaptive
 * thinking — instead of some ids answering and others returning 400.
 */
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '@/core/config';
import { apiKeyFor, keyEnvVarFor } from '@/core/keys';
import type { RemoteProviderConfig } from '@/shapes';
import type { CliChildHandle, CliTransport, SpawnOptions } from './run-session';
import type { ChatMessage } from './chat';
import { HttpChildHandle } from './http-session';
import type { RemoteAvailability } from './openai';

const LABEL = 'Anthropic';
const PROBE_TIMEOUT_MS = 8000;

/**
 * WHY 16000 and not the 128K the current models allow: this is a ceiling that must hold
 * for whatever model id is in the settings box, and the smaller models cap well below
 * 128K — asking for more is a 400 on those rather than a longer lesson. A finished lesson
 * is a few thousand tokens, so this is roughly three times the largest one ever written.
 */
const MAX_TOKENS = 16000;

export function anthropicMissingKeyMessage(): string {
  return `No API key for ${LABEL}. Set ${keyEnvVarFor('anthropic') ?? 'LA_ANTHROPIC_KEY'} in your .env file.`;
}

/** WHY the key is fetched per call and never stored on the client: `src/core/keys.ts` is
 *  the only place a key is read, and a client cached across a `.env` edit would keep
 *  using the key the process started with. */
function clientFor(settings: RemoteProviderConfig): Anthropic {
  const apiKey = apiKeyFor('anthropic');
  if (apiKey === null) throw new Error(anthropicMissingKeyMessage());
  return new Anthropic({ apiKey, baseURL: settings.baseUrl });
}

/** Turns an SDK error into the one sentence a learner can act on. */
function describe(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) {
    return `${LABEL} rejected the API key. Check ${keyEnvVarFor('anthropic') ?? 'the key variable'}.`;
  }
  if (e instanceof Anthropic.NotFoundError) return `${LABEL} does not know that model id.`;
  if (e instanceof Anthropic.RateLimitError) return `${LABEL} is rate limiting this key; try again shortly.`;
  if (e instanceof Anthropic.APIConnectionError) return `${LABEL} could not be reached.`;
  if (e instanceof Anthropic.APIError) return `${LABEL} answered ${String(e.status)}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

class AnthropicChildHandle extends HttpChildHandle {
  protected readonly label = LABEL;

  constructor(argv: readonly string[], private readonly settings: RemoteProviderConfig) {
    super(argv);
  }

  protected async ask(messages: ChatMessage[]): Promise<string> {
    if (this.settings.model.trim().length === 0) throw new Error(`${LABEL} has no model configured.`);
    const client = clientFor(this.settings);
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n\n');
    try {
      // WHY streaming rather than a single create(): with a large max_tokens the SDK's
      // own HTTP timeout is the thing that fails a long lesson, and streaming is how the
      // documented API says to avoid it. The answer is still consumed whole.
      const stream = client.messages.stream(
        {
          model: this.settings.model,
          max_tokens: MAX_TOKENS,
          ...(system === '' ? {} : { system }),
          messages: [{ role: 'user', content: user }],
        },
        { signal: this.controller.signal },
      );
      const message = await stream.finalMessage();
      // WHY a refusal is named rather than left as empty output: the request completed,
      // so "no content" would send the learner looking for a fault in their network.
      if (message.stop_reason === 'refusal') {
        throw new Error(`${LABEL} declined to answer this prompt.`);
      }
      return message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');
    } catch (e) {
      if (this.controller.signal.aborted) throw e;
      throw new Error(describe(e));
    }
  }
}

export class AnthropicTransport implements CliTransport {
  constructor(private readonly settings?: RemoteProviderConfig) {}

  spawn(_bin: string, argv: string[], _opts: SpawnOptions): CliChildHandle {
    return new AnthropicChildHandle(argv, this.settings ?? loadConfig().anthropic);
  }
}

/** Reachable, key accepted, model offered — proven without spending a generation. */
export async function checkAnthropicAvailable(settings: RemoteProviderConfig): Promise<RemoteAvailability> {
  if (apiKeyFor('anthropic') === null) {
    return { ok: false, reason: 'unusable', message: anthropicMissingKeyMessage() };
  }
  if (settings.model.trim().length === 0) {
    return { ok: false, reason: 'unusable', message: `${LABEL} has no model configured.` };
  }
  let ids: string[];
  try {
    const client = clientFor(settings);
    const page = await client.models.list({ limit: 100 }, { timeout: PROBE_TIMEOUT_MS, maxRetries: 0 });
    ids = page.data.map((m) => m.id);
  } catch (e) {
    if (e instanceof Anthropic.APIConnectionError) {
      return { ok: false, reason: 'missing', message: `Nothing answered at ${settings.baseUrl}.` };
    }
    return { ok: false, reason: 'unusable', message: describe(e) };
  }
  if (ids.length > 0 && !ids.includes(settings.model)) {
    return {
      ok: false,
      reason: 'unusable',
      message: `${LABEL} does not offer "${settings.model}". Available: ${ids.slice(0, 5).join(', ')}.`,
    };
  }
  return { ok: true, version: `anthropic · ${settings.model}` };
}
