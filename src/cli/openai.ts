// FRACTAL: implements F6 | component C2
/**
 * The `/v1/chat/completions` transport — one adapter, most of the world.
 *
 * WHY this is the important one: OpenAI's chat-completions shape is what LM Studio, vLLM,
 * llama.cpp's own server, OpenRouter, Groq, Together, DeepSeek, Fireworks and Mistral all
 * speak. Writing it once with the address as a setting turns "add a provider" from a
 * release into a URL the learner types, which is the difference between shipping eight
 * providers and shipping the long tail. `openai-compatible` is therefore a first-class
 * provider here, not a fallback: it is the one that covers everything unnamed.
 *
 * WHY OpenAI and Mistral share it rather than getting a file each: they are the same wire
 * format down to the `response_format` field. A second copy would be a second place for
 * the streaming reassembly to be subtly wrong, and only one of the two would get fixed.
 * What genuinely differs — the address, the model id, which env var holds the key — is
 * configuration, and it already lives in `AppConfig` and `src/core/keys.ts`.
 */
import { loadConfig } from '@/core/config';
import { apiKeyFor, keyEnvVarFor } from '@/core/keys';
import type { RemoteProviderConfig, RemoteProviderKind } from '@/shapes';
import { remoteSectionOf } from '@/shapes';
import type { CliChildHandle, CliTransport, SpawnOptions } from './run-session';
import type { ChatMessage } from './chat';
import { HttpChildHandle, endpointOf, excerpt, peekBody, readEventStream } from './http-session';

/** How each provider on this wire format is named in a message a learner reads. */
const LABELS: Record<string, string> = {
  openai: 'OpenAI',
  'openai-compatible': 'The OpenAI-compatible endpoint',
  mistral: 'Mistral',
};

export function openAiLabel(provider: RemoteProviderKind): string {
  return LABELS[provider] ?? provider;
}

/**
 * WHY a key is optional here and required by the caller for two of the three: an
 * OpenAI-compatible server on this machine (LM Studio, vLLM, llama.cpp) usually wants no
 * key at all, and demanding one would lock out the very endpoints this adapter exists for.
 */
function authHeaders(provider: RemoteProviderKind): Record<string, string> {
  const key = apiKeyFor(provider);
  return key === null ? {} : { authorization: `Bearer ${key}` };
}

/** The message that names the variable to set, when a provider that needs a key has none. */
export function missingKeyMessage(provider: RemoteProviderKind): string {
  return `No API key for ${openAiLabel(provider)}. Set ${keyEnvVarFor(provider) ?? 'the key variable'} in your .env file.`;
}

class OpenAiChildHandle extends HttpChildHandle {
  protected readonly label: string;

  constructor(
    argv: readonly string[],
    private readonly provider: RemoteProviderKind,
    private readonly settings: RemoteProviderConfig,
  ) {
    super(argv);
    this.label = openAiLabel(provider);
  }

  protected async ask(messages: ChatMessage[]): Promise<string> {
    let response = await this.post(messages, true);
    let detail = response.ok ? '' : await peekBody(response);
    // WHY the retry: `response_format` and a non-default `temperature` are the two fields
    // this long tail disagrees about — OpenAI's reasoning models reject a temperature,
    // and some compatible servers have never implemented JSON mode. Asking for both and
    // falling back keeps one code path instead of a table of which endpoint supports
    // what, which would be stale the week after it was written.
    if (response.status === 400) {
      response = await this.post(messages, false);
      detail = response.ok ? '' : await peekBody(response);
    }
    if (!response.ok) {
      throw new Error(`${this.label} answered ${response.status}${excerpt(detail)}`);
    }
    let text = '';
    let failure: string | null = null;
    await readEventStream(response, (payload) => {
      let frame: { choices?: { delta?: { content?: unknown } }[]; error?: { message?: unknown } };
      try {
        frame = JSON.parse(payload) as typeof frame;
      } catch {
        // WHY tolerated: a partial frame is normal mid-stream and is flushed at the end.
        return;
      }
      if (frame.error !== undefined) {
        const message = typeof frame.error.message === 'string' ? frame.error.message : 'unknown error';
        failure = `${this.label} reported an error: ${message}`;
        return;
      }
      const delta = frame.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') text += delta;
    });
    if (failure !== null) throw new Error(failure);
    return text;
  }

  private post(messages: ChatMessage[], constrained: boolean): Promise<Response> {
    const body = {
      model: this.settings.model,
      messages,
      stream: true,
      ...(constrained ? { response_format: { type: 'json_object' }, temperature: 0.2 } : {}),
    };
    return fetch(endpointOf(this.settings.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(this.provider) },
      body: JSON.stringify(body),
      signal: this.controller.signal,
    });
  }
}

export class OpenAiTransport implements CliTransport {
  constructor(
    private readonly provider: RemoteProviderKind,
    private readonly settings?: RemoteProviderConfig,
  ) {}

  spawn(_bin: string, argv: string[], _opts: SpawnOptions): CliChildHandle {
    const config = loadConfig();
    return new OpenAiChildHandle(argv, this.provider, this.settings ?? config[remoteSectionOf[this.provider]]);
  }
}

export type RemoteAvailability =
  | { ok: true; version: string }
  | { ok: false; reason: 'missing' | 'unusable'; message: string };

const PROBE_TIMEOUT_MS = 8000;

/**
 * Answers the same question `checkClaudeAvailable` does — can a session actually run? —
 * without spending a generation on it.
 *
 * WHY the model list and not a one-token completion: opening Settings must cost nothing,
 * and `GET /models` proves the address is right, the key is accepted and the model exists
 * in one free call. The Settings screen's "Test connection" button is where a real
 * request is made, because that is a press the learner chose.
 */
export async function checkOpenAiAvailable(
  provider: RemoteProviderKind,
  settings: RemoteProviderConfig,
): Promise<RemoteAvailability> {
  const label = openAiLabel(provider);
  // WHY openai-compatible is exempt: the endpoint this adapter most often points at runs
  // on this machine and has no key at all, so demanding one would refuse the common case.
  if (provider !== 'openai-compatible' && apiKeyFor(provider) === null) {
    return { ok: false, reason: 'unusable', message: missingKeyMessage(provider) };
  }
  let ids: string[];
  try {
    const response = await fetch(endpointOf(settings.baseUrl, '/models'), {
      headers: authHeaders(provider),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await peekBody(response);
      return {
        ok: false,
        reason: 'unusable',
        message: `${label} answered ${response.status} at ${settings.baseUrl}${excerpt(detail)}`,
      };
    }
    const parsed = (await response.json()) as { data?: { id?: unknown }[] };
    ids = Array.isArray(parsed.data)
      ? parsed.data.map((m) => (typeof m.id === 'string' ? m.id : '')).filter((id) => id.length > 0)
      : [];
  } catch {
    return { ok: false, reason: 'missing', message: `Nothing answered at ${settings.baseUrl}.` };
  }
  if (settings.model.trim().length === 0) {
    return { ok: false, reason: 'unusable', message: `${label} is reachable, but no model is named.` };
  }
  // WHY a non-empty list is required before refusing: some compatible servers answer
  // `/models` with an empty array, and reporting "the model is missing" on the word of an
  // endpoint that lists nothing would be this screen inventing a fault.
  if (ids.length > 0 && !ids.includes(settings.model)) {
    return {
      ok: false,
      reason: 'unusable',
      message: `${label} does not offer "${settings.model}". Available: ${ids.slice(0, 5).join(', ')}.`,
    };
  }
  return { ok: true, version: `${label.toLowerCase()} · ${settings.model}` };
}
