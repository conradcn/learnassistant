// FRACTAL: implements F6 | component C0
/**
 * Where an API key comes from, and the only place it is ever read.
 *
 * WHY it is not part of `AppConfig`: `AppConfig` is written to `config.json` on every
 * Settings save, and a field that can be persisted eventually is. A key here is read from
 * the process environment (which Next populates from `.env`) at the moment it is used and
 * held in no config object, no SQLite row and no log line — so "never persisted" is a
 * property of the shape rather than a rule somebody has to keep remembering.
 *
 * WHY the vendor's own variable is accepted as a fallback: a machine that already talks to
 * OpenAI has `OPENAI_API_KEY` set, and asking for the same secret again under a second
 * name is a setup step that buys nothing. The `LA_` name wins when both are present, so
 * this app's setting is never silently overridden by an ambient one.
 */
import type { ProviderKind, RemoteProviderKind } from '@/shapes';
import { isRemoteProvider } from '@/shapes';

/** The variable this app documents for each hosted provider, and the vendor's own. */
const KEY_ENV_VARS: Record<RemoteProviderKind, readonly [string, ...string[]]> = {
  anthropic: ['LA_ANTHROPIC_KEY', 'ANTHROPIC_API_KEY'],
  openai: ['LA_OPENAI_KEY', 'OPENAI_API_KEY'],
  'openai-compatible': ['LA_OPENAI_COMPAT_KEY'],
  gemini: ['LA_GEMINI_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  mistral: ['LA_MISTRAL_KEY', 'MISTRAL_API_KEY'],
};

/** WHY it reads through `hasOwnProperty` and trims: an exported-but-empty variable is
 *  "not set" here, not "set to the empty string" (H1 — never branch on definedness). */
function readEnv(name: string): string | null {
  const raw = Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** The variable name Settings should name to a learner whose key is missing. */
export function keyEnvVarFor(provider: ProviderKind): string | null {
  if (!isRemoteProvider(provider)) return null;
  return KEY_ENV_VARS[provider][0];
}

/**
 * The key for this provider, or null when none is set.
 *
 * WHY a local provider returns null rather than throwing: "no key" is the correct and
 * complete answer for Ollama, llama.cpp and the CLI, and every caller already has to
 * handle a key that is simply not there.
 */
export function apiKeyFor(provider: ProviderKind): string | null {
  if (!isRemoteProvider(provider)) return null;
  for (const name of KEY_ENV_VARS[provider]) {
    const value = readEnv(name);
    if (value !== null) return value;
  }
  return null;
}

/** Whether a key is available without revealing anything about it. */
export function hasApiKey(provider: ProviderKind): boolean {
  return apiKeyFor(provider) !== null;
}

/** Every variable name this module will read — used by the docs check and by `scrub`. */
export function allKeyEnvVars(): string[] {
  return Object.values(KEY_ENV_VARS).flatMap((names) => [...names]);
}
