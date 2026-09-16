// FRACTAL: implements F6 | component C2
/**
 * Google Gemini, over its own `generateContent` wire format.
 *
 * WHY this one does not share the OpenAI adapter: Gemini is the one provider here that is
 * genuinely a different shape — the system prompt is `systemInstruction`, a turn is
 * `contents[].parts[].text`, the key travels in a header of its own, and the model id is
 * part of the URL rather than the body. Google does publish an OpenAI-compatible endpoint,
 * but pointing at it would mean the app's "Gemini" setting quietly depended on a
 * compatibility shim; a learner who wants that route already has `openai-compatible`.
 */
import { loadConfig } from '@/core/config';
import { apiKeyFor, keyEnvVarFor } from '@/core/keys';
import type { RemoteProviderConfig } from '@/shapes';
import type { CliChildHandle, CliTransport, SpawnOptions } from './run-session';
import type { ChatMessage } from './chat';
import { HttpChildHandle, endpointOf, excerpt, peekBody, readEventStream } from './http-session';
import type { RemoteAvailability } from './openai';

const LABEL = 'Gemini';
const PROBE_TIMEOUT_MS = 8000;

function keyHeaders(): Record<string, string> | null {
  const key = apiKeyFor('gemini');
  return key === null ? null : { 'x-goog-api-key': key };
}

export function geminiMissingKeyMessage(): string {
  return `No API key for ${LABEL}. Set ${keyEnvVarFor('gemini') ?? 'LA_GEMINI_KEY'} in your .env file.`;
}

class GeminiChildHandle extends HttpChildHandle {
  protected readonly label = LABEL;

  constructor(argv: readonly string[], private readonly settings: RemoteProviderConfig) {
    super(argv);
  }

  protected async ask(messages: ChatMessage[]): Promise<string> {
    const headers = keyHeaders();
    if (headers === null) throw new Error(geminiMissingKeyMessage());
    if (this.settings.model.trim().length === 0) throw new Error(`${LABEL} has no model configured.`);

    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n\n');
    const body = {
      contents: [{ role: 'user', parts: [{ text: user }] }],
      ...(system === '' ? {} : { systemInstruction: { parts: [{ text: system }] } }),
      // WHY the mime type: every output contract in src/cli/prompt.ts asks for exactly one
      // JSON object, and constraining decoding to JSON is what stops the answer arriving
      // wrapped in a paragraph of explanation the schema check would then refuse.
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    };
    // WHY `alt=sse` and the streaming endpoint: a single-shot generateContent sends no
    // headers until the whole lesson is written, and Node's fetch gives up on a
    // header-less response after five minutes.
    const url = `${endpointOf(this.settings.baseUrl, `/models/${encodeURIComponent(this.settings.model)}:streamGenerateContent`)}?alt=sse`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: this.controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${LABEL} answered ${response.status}${excerpt(await peekBody(response))}`);
    }

    let text = '';
    let failure: string | null = null;
    await readEventStream(response, (payload) => {
      let frame: {
        candidates?: { content?: { parts?: { text?: unknown }[] }; finishReason?: unknown }[];
        error?: { message?: unknown };
      };
      try {
        frame = JSON.parse(payload) as typeof frame;
      } catch {
        // a partial frame is normal mid-stream and is flushed at the end
        return;
      }
      if (frame.error !== undefined) {
        const message = typeof frame.error.message === 'string' ? frame.error.message : 'unknown error';
        failure = `${LABEL} reported an error: ${message}`;
        return;
      }
      // WHY the finish reason is surfaced: a safety block or a token cap returns HTTP 200
      // with no text at all, and "returned no message content" would send the learner
      // looking for a network fault that is not there.
      const candidate = frame.candidates?.[0];
      const reason = candidate?.finishReason;
      if (typeof reason === 'string' && reason !== 'STOP' && reason !== 'MAX_TOKENS') {
        failure = `${LABEL} stopped early (${reason}).`;
        return;
      }
      for (const part of candidate?.content?.parts ?? []) {
        if (typeof part.text === 'string') text += part.text;
      }
    });
    if (failure !== null) throw new Error(failure);
    return text;
  }
}

export class GeminiTransport implements CliTransport {
  constructor(private readonly settings?: RemoteProviderConfig) {}

  spawn(_bin: string, argv: string[], _opts: SpawnOptions): CliChildHandle {
    return new GeminiChildHandle(argv, this.settings ?? loadConfig().gemini);
  }
}

/** Reachable, key accepted, model offered — proven without spending a generation. */
export async function checkGeminiAvailable(settings: RemoteProviderConfig): Promise<RemoteAvailability> {
  const headers = keyHeaders();
  if (headers === null) return { ok: false, reason: 'unusable', message: geminiMissingKeyMessage() };
  let names: string[];
  try {
    const response = await fetch(endpointOf(settings.baseUrl, '/models'), {
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: 'unusable',
        message: `${LABEL} answered ${response.status} at ${settings.baseUrl}${excerpt(await peekBody(response))}`,
      };
    }
    const parsed = (await response.json()) as { models?: { name?: unknown }[] };
    // WHY the prefix is stripped: Gemini lists a model as `models/gemini-2.5-flash`, and
    // the id the request needs is the part after the slash — which is what Settings holds.
    names = Array.isArray(parsed.models)
      ? parsed.models
          .map((m) => (typeof m.name === 'string' ? m.name.replace(/^models\//, '') : ''))
          .filter((n) => n.length > 0)
      : [];
  } catch {
    return { ok: false, reason: 'missing', message: `Nothing answered at ${settings.baseUrl}.` };
  }
  if (settings.model.trim().length === 0) {
    return { ok: false, reason: 'unusable', message: `${LABEL} is reachable, but no model is named.` };
  }
  if (names.length > 0 && !names.includes(settings.model)) {
    return {
      ok: false,
      reason: 'unusable',
      message: `${LABEL} does not offer "${settings.model}". Available: ${names.slice(0, 5).join(', ')}.`,
    };
  }
  return { ok: true, version: `gemini · ${settings.model}` };
}
