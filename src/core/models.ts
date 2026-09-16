// FRACTAL: implements F6 | component C0
/**
 * Which model runs which job.
 *
 * WHY this is one module and not a branch at each spawn: "lesson planning" and "chat" are
 * not two providers, they are two roles played by the same provider with — optionally —
 * two different models. Every place that dials a model (the transports, the Claude argv,
 * the Settings probe) has to agree on the same three answers: what role is this session,
 * which model does that role name, and what does an unset override fall back to. Asking
 * that here once is what keeps "chat uses the small model" from being true in the
 * transport and false in the availability probe.
 */
import type {
  AppConfig,
  CliSessionSpec,
  LlamaConfig,
  OllamaConfig,
  RemoteProviderConfig,
  RemoteProviderKind,
} from '@/shapes';
import { remoteSectionOf } from '@/shapes';

export type SessionRole = 'planning' | 'chat';

/**
 * WHY only `evaluate` is chat: it is the one kind whose prompt is a turn in a
 * conversation a learner is sitting in front of, waiting. Everything else — authoring a
 * module, researching a topic, writing a capstone spec, a detour, a review — is work the
 * app does ahead of the learner and is judged on quality, not latency.
 */
export function roleOfKind(kind: CliSessionSpec['kind']): SessionRole {
  // WHY `ask` is chat: it is the learner talking to their tutor mid-lesson, so it wants
  // the same model the conversation uses, not the one that writes lessons.
  // `diagnostic` likewise: the learner is sitting at the intake form waiting on each question.
  return kind === 'evaluate' || kind === 'ask' || kind === 'diagnostic' ? 'chat' : 'planning';
}

function override(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** The Ollama address and model this role should use. */
export function ollamaSettingsFor(config: AppConfig, role: SessionRole): OllamaConfig {
  const chat = role === 'chat' ? override(config.chatModels.ollama) : null;
  return chat === null ? { ...config.ollama } : { ...config.ollama, model: chat };
}

/**
 * The llama.cpp binary, address and model file this role should use.
 *
 * WHY the baseUrl moves with the model and the binPath does not: one llama-server serves
 * one model file, so a chat model is a second server — on its own port, started from the
 * same executable.
 */
export function llamaSettingsFor(config: AppConfig, role: SessionRole): LlamaConfig {
  const chat = role === 'chat' ? override(config.chatModels.llama.modelPath) : null;
  if (chat === null) return { ...config.llama };
  return {
    ...config.llama,
    baseUrl: config.chatModels.llama.baseUrl,
    modelPath: chat,
  };
}

/** The `--model` the Claude CLI should be given for this role, or null for its default. */
export function claudeModelFor(config: AppConfig, role: SessionRole): string | null {
  if (role === 'chat') {
    const chat = override(config.chatModels.claude);
    if (chat !== null) return chat;
  }
  return override(config.claudeModel);
}

/**
 * The address and model a hosted provider should use for this role.
 *
 * WHY one function for all five and not one per vendor: the question is the same for every
 * one of them — which section of the config does this provider own, and does the chat role
 * name a different model inside it — and five copies of that answer is five places for a
 * newly added provider to be forgotten. The section mapping lives in `remoteSectionOf`, so
 * a provider that exists in `ProviderKind` cannot be missing from here.
 */
export function remoteSettingsFor(
  config: AppConfig,
  provider: RemoteProviderKind,
  role: SessionRole,
): RemoteProviderConfig {
  const section = remoteSectionOf[provider];
  const chat = role === 'chat' ? override(config.chatModels[section]) : null;
  return chat === null ? { ...config[section] } : { ...config[section], model: chat };
}
