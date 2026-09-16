// FRACTAL: implements (none) | component C0
import { openSync, writeSync, fsyncSync, closeSync, renameSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig, ChatModels, ProviderKind, RemoteProviderKind, RemoteSection } from '@/shapes';
import { exampleAppConfig, providerKindSchema, remoteProviderKinds, remoteSectionOf } from '@/shapes';

let cachedConfig: AppConfig | null = null;

function defaults(): AppConfig {
  return {
    dataRoot: exampleAppConfig.dataRoot,
    port: exampleAppConfig.port,
    sessionConcurrency: exampleAppConfig.sessionConcurrency,
    claudeBin: exampleAppConfig.claudeBin,
    claudeModel: exampleAppConfig.claudeModel,
    provider: exampleAppConfig.provider,
    ollama: { ...exampleAppConfig.ollama },
    llama: { ...exampleAppConfig.llama },
    anthropic: { ...exampleAppConfig.anthropic },
    openai: { ...exampleAppConfig.openai },
    openaiCompatible: { ...exampleAppConfig.openaiCompatible },
    gemini: { ...exampleAppConfig.gemini },
    mistral: { ...exampleAppConfig.mistral },
    chatModels: {
      ...exampleAppConfig.chatModels,
      llama: { ...exampleAppConfig.chatModels.llama },
    },
    configWarnings: [],
  };
}

/** The `LA_` prefix each hosted provider's URL and model variables share. */
const REMOTE_ENV_PREFIX: Record<RemoteProviderKind, string> = {
  anthropic: 'LA_ANTHROPIC',
  openai: 'LA_OPENAI',
  'openai-compatible': 'LA_OPENAI_COMPAT',
  gemini: 'LA_GEMINI',
  mistral: 'LA_MISTRAL',
};

/** The chat-model override key each hosted provider owns in `chatModels`.
 *  WHY derived and not listed: a hand-written second list is a list that goes stale the
 *  first time a provider is added, and it would go stale silently. */
const REMOTE_CHAT_KEYS = remoteProviderKinds.map((kind) => remoteSectionOf[kind]);

function isValidProvider(v: unknown): v is ProviderKind {
  return providerKindSchema.safeParse(v).success;
}

/** WHY: an Ollama base URL is dialled by the server process, so it has to be a URL it
 *  can actually reach — a typo'd value should be refused at the edge, not at 3am in a
 *  session failure. http(s) only; anything else is not something fetch will honour. */
function isValidBaseUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.trim().length === 0) return false;
  try {
    const url = new URL(v.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function configFilePath(dataRoot: string): string {
  return path.join(path.resolve(dataRoot), 'config.json');
}

function applyFileLayer(base: AppConfig, dataRoot: string): AppConfig {
  const filePath = configFilePath(dataRoot);
  if (!existsSync(filePath)) return base;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return { ...base, configWarnings: [...base.configWarnings, `${filePath} could not be parsed; using defaults.`] };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...base, configWarnings: [...base.configWarnings, `${filePath} could not be parsed; using defaults.`] };
  }
  const result: AppConfig = { ...base };
  const warnings = [...base.configWarnings];
  const record = raw as Record<string, unknown>;

  if ('dataRoot' in record) {
    if (typeof record.dataRoot === 'string' && record.dataRoot.trim().length > 0) {
      result.dataRoot = record.dataRoot;
    } else {
      warnings.push('dataRoot was invalid; using default.');
    }
  }
  if ('port' in record) {
    if (isPositiveInt(record.port) && record.port <= 65535) {
      result.port = record.port;
    } else {
      warnings.push('port was invalid; using default.');
    }
  }
  if ('claudeBin' in record) {
    if (typeof record.claudeBin === 'string' && record.claudeBin.trim().length > 0) {
      result.claudeBin = record.claudeBin;
    } else {
      warnings.push('claudeBin was invalid; using default.');
    }
  }
  // WHY '' is accepted here where claudeBin's '' is not: an empty claudeBin is no binary
  // to run, but an empty model is "whatever the CLI defaults to", which is the shipped
  // state and the way back to it after trying a specific model.
  if ('claudeModel' in record) {
    if (typeof record.claudeModel === 'string') {
      result.claudeModel = record.claudeModel.trim();
    } else {
      warnings.push('claudeModel was invalid; using default.');
    }
  }
  if ('provider' in record) {
    if (isValidProvider(record.provider)) {
      result.provider = record.provider;
    } else {
      warnings.push('provider was invalid; using default.');
    }
  }
  if ('ollama' in record && typeof record.ollama === 'object' && record.ollama !== null) {
    const ollama = record.ollama as Record<string, unknown>;
    result.ollama = { ...result.ollama };
    if ('baseUrl' in ollama) {
      if (isValidBaseUrl(ollama.baseUrl)) {
        result.ollama.baseUrl = (ollama.baseUrl as string).trim();
      } else {
        warnings.push('ollama.baseUrl was invalid; using default.');
      }
    }
    if ('model' in ollama) {
      if (typeof ollama.model === 'string' && ollama.model.trim().length > 0) {
        result.ollama.model = ollama.model.trim();
      } else {
        warnings.push('ollama.model was invalid; using default.');
      }
    }
  } else if ('ollama' in record) {
    warnings.push('ollama was invalid; using default.');
  }
  if ('llama' in record && typeof record.llama === 'object' && record.llama !== null) {
    const llama = record.llama as Record<string, unknown>;
    result.llama = { ...result.llama };
    if ('baseUrl' in llama) {
      if (isValidBaseUrl(llama.baseUrl)) {
        result.llama.baseUrl = (llama.baseUrl as string).trim();
      } else {
        warnings.push('llama.baseUrl was invalid; using default.');
      }
    }
    if ('binPath' in llama) {
      if (typeof llama.binPath === 'string' && llama.binPath.trim().length > 0) {
        result.llama.binPath = llama.binPath.trim();
      } else {
        warnings.push('llama.binPath was invalid; using default.');
      }
    }
    // WHY modelPath tolerates '': it is the shipped default, and the honest state of a
    // machine with llama.cpp but no model chosen yet. The probe explains it; the config
    // layer refusing it would only replace one empty value with the same empty value.
    if ('modelPath' in llama) {
      if (typeof llama.modelPath === 'string') {
        result.llama.modelPath = llama.modelPath.trim();
      } else {
        warnings.push('llama.modelPath was invalid; using default.');
      }
    }
  } else if ('llama' in record) {
    warnings.push('llama was invalid; using default.');
  }
  // WHY the model tolerates '' and the address does not: an empty model is the honest
  // "not chosen yet" for an endpoint that names its own models, and the probe says so.
  // An address is dialled, so a typo there has to be refused here rather than at 3am.
  for (const kind of remoteProviderKinds) {
    const section = remoteSectionOf[kind];
    if (section in record && typeof record[section] === 'object' && record[section] !== null) {
      const raw = record[section] as Record<string, unknown>;
      result[section] = { ...result[section] };
      if ('baseUrl' in raw) {
        if (isValidBaseUrl(raw.baseUrl)) {
          result[section].baseUrl = (raw.baseUrl as string).trim();
        } else {
          warnings.push(`${section}.baseUrl was invalid; using default.`);
        }
      }
      if ('model' in raw) {
        if (typeof raw.model === 'string') {
          result[section].model = raw.model.trim();
        } else {
          warnings.push(`${section}.model was invalid; using default.`);
        }
      }
    } else if (section in record) {
      warnings.push(`${section} was invalid; using default.`);
    }
  }
  if ('chatModels' in record && typeof record.chatModels === 'object' && record.chatModels !== null) {
    const chat = record.chatModels as Record<string, unknown>;
    result.chatModels = { ...result.chatModels, llama: { ...result.chatModels.llama } };
    for (const key of ['claude', 'ollama', ...REMOTE_CHAT_KEYS] as ('claude' | 'ollama' | RemoteSection)[]) {
      if (key in chat) {
        if (typeof chat[key] === 'string') {
          result.chatModels[key] = (chat[key] as string).trim();
        } else {
          warnings.push(`chatModels.${key} was invalid; using default.`);
        }
      }
    }
    if ('llama' in chat && typeof chat.llama === 'object' && chat.llama !== null) {
      const chatLlama = chat.llama as Record<string, unknown>;
      if ('baseUrl' in chatLlama) {
        if (isValidBaseUrl(chatLlama.baseUrl)) {
          result.chatModels.llama.baseUrl = (chatLlama.baseUrl as string).trim();
        } else {
          warnings.push('chatModels.llama.baseUrl was invalid; using default.');
        }
      }
      if ('modelPath' in chatLlama) {
        if (typeof chatLlama.modelPath === 'string') {
          result.chatModels.llama.modelPath = chatLlama.modelPath.trim();
        } else {
          warnings.push('chatModels.llama.modelPath was invalid; using default.');
        }
      }
    } else if ('llama' in chat) {
      warnings.push('chatModels.llama was invalid; using default.');
    }
  } else if ('chatModels' in record) {
    warnings.push('chatModels was invalid; using default.');
  }
  if ('sessionConcurrency' in record) {
    if (isPositiveInt(record.sessionConcurrency)) {
      result.sessionConcurrency = record.sessionConcurrency;
    } else {
      warnings.push('sessionConcurrency was invalid; using default.');
    }
  }

  result.configWarnings = warnings;
  return result;
}

/** The single env reader. Returns a trimmed value or null; never branches on definedness (H1). */
function readEnv(name: string): string | null {
  const raw = Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function applyEnvLayer(base: AppConfig): AppConfig {
  const result: AppConfig = {
    ...base,
    ollama: { ...base.ollama },
    llama: { ...base.llama },
    anthropic: { ...base.anthropic },
    openai: { ...base.openai },
    openaiCompatible: { ...base.openaiCompatible },
    gemini: { ...base.gemini },
    mistral: { ...base.mistral },
    chatModels: { ...base.chatModels, llama: { ...base.chatModels.llama } },
  };
  const warnings = [...base.configWarnings];

  const dataRoot = readEnv('LA_DATA_ROOT');
  if (dataRoot !== null) {
    result.dataRoot = dataRoot;
  }
  const portRaw = readEnv('PORT');
  if (portRaw !== null) {
    const port = Number(portRaw);
    if (isPositiveInt(port) && port <= 65535) {
      result.port = port;
    } else {
      warnings.push('PORT env var was invalid; using default.');
    }
  }
  const claudeBin = readEnv('LA_CLAUDE_BIN');
  if (claudeBin !== null) {
    result.claudeBin = claudeBin;
  }
  const claudeModel = readEnv('LA_CLAUDE_MODEL');
  if (claudeModel !== null) {
    result.claudeModel = claudeModel;
  }
  const chatClaudeModel = readEnv('LA_CHAT_CLAUDE_MODEL');
  if (chatClaudeModel !== null) {
    result.chatModels.claude = chatClaudeModel;
  }
  const chatOllamaModel = readEnv('LA_CHAT_OLLAMA_MODEL');
  if (chatOllamaModel !== null) {
    result.chatModels.ollama = chatOllamaModel;
  }
  const chatLlamaModel = readEnv('LA_CHAT_LLAMA_MODEL');
  if (chatLlamaModel !== null) {
    result.chatModels.llama.modelPath = chatLlamaModel;
  }
  const chatLlamaUrl = readEnv('LA_CHAT_LLAMA_URL');
  if (chatLlamaUrl !== null) {
    if (isValidBaseUrl(chatLlamaUrl)) {
      result.chatModels.llama.baseUrl = chatLlamaUrl;
    } else {
      warnings.push('LA_CHAT_LLAMA_URL env var was invalid; using default.');
    }
  }
  const provider = readEnv('LA_PROVIDER');
  if (provider !== null) {
    if (isValidProvider(provider)) {
      result.provider = provider;
    } else {
      warnings.push('LA_PROVIDER env var was invalid; using default.');
    }
  }
  const ollamaUrl = readEnv('LA_OLLAMA_URL');
  if (ollamaUrl !== null) {
    if (isValidBaseUrl(ollamaUrl)) {
      result.ollama.baseUrl = ollamaUrl;
    } else {
      warnings.push('LA_OLLAMA_URL env var was invalid; using default.');
    }
  }
  const ollamaModel = readEnv('LA_OLLAMA_MODEL');
  if (ollamaModel !== null) {
    result.ollama.model = ollamaModel;
  }
  const llamaUrl = readEnv('LA_LLAMA_URL');
  if (llamaUrl !== null) {
    if (isValidBaseUrl(llamaUrl)) {
      result.llama.baseUrl = llamaUrl;
    } else {
      warnings.push('LA_LLAMA_URL env var was invalid; using default.');
    }
  }
  const llamaBin = readEnv('LA_LLAMA_BIN');
  if (llamaBin !== null) {
    result.llama.binPath = llamaBin;
  }
  const llamaModel = readEnv('LA_LLAMA_MODEL');
  if (llamaModel !== null) {
    result.llama.modelPath = llamaModel;
  }
  // WHY the same three variables per provider, spelled from one prefix: `LA_OLLAMA_URL`
  // and `LA_OLLAMA_MODEL` are the shape every install already knows, and a hosted provider
  // adds exactly one more — its key, which is read in src/core/keys.ts and never here,
  // because anything that lands in `AppConfig` is written to config.json on the next save.
  for (const kind of remoteProviderKinds) {
    const section = remoteSectionOf[kind];
    const prefix = REMOTE_ENV_PREFIX[kind];
    const url = readEnv(`${prefix}_URL`);
    if (url !== null) {
      if (isValidBaseUrl(url)) {
        result[section].baseUrl = url;
      } else {
        warnings.push(`${prefix}_URL env var was invalid; using default.`);
      }
    }
    const model = readEnv(`${prefix}_MODEL`);
    if (model !== null) {
      result[section].model = model;
    }
    const chatModel = readEnv(`LA_CHAT_${prefix.slice('LA_'.length)}_MODEL`);
    if (chatModel !== null) {
      result.chatModels[section] = chatModel;
    }
  }
  const concRaw = readEnv('LA_SESSION_CONCURRENCY');
  if (concRaw !== null) {
    const conc = Number(concRaw);
    if (isPositiveInt(conc)) {
      result.sessionConcurrency = conc;
    } else {
      warnings.push('LA_SESSION_CONCURRENCY env var was invalid; using default.');
    }
  }
  result.configWarnings = warnings;
  return result;
}

export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;
  try {
    const base = defaults();
    const withFile = applyFileLayer(base, readEnv('LA_DATA_ROOT') ?? base.dataRoot);
    const withEnv = applyEnvLayer(withFile);
    cachedConfig = withEnv;
    return cachedConfig;
  } catch {
    cachedConfig = { ...defaults(), configWarnings: ['configuration could not be read; using defaults.'] };
    return cachedConfig;
  }
}

export function resetConfigCache(): void {
  cachedConfig = null;
}

/**
 * What a caller may change in one save.
 *
 * WHY `chatModels` is partial where `AppConfig`'s is not: with one entry per provider the
 * set is now eight fields wide, and a caller that only wants to name the OpenAI chat model
 * would otherwise have to restate the other seven — restating a value is how a value gets
 * silently reset. The merge below fills every field it is not given from the current config.
 */
export type ConfigPatch = Partial<Omit<AppConfig, 'chatModels'>> & {
  chatModels?: Partial<Omit<ChatModels, 'llama'>> & { llama?: Partial<ChatModels['llama']> };
};

export function saveConfig(patch: ConfigPatch): AppConfig {
  const current = loadConfig();
  const merged: AppConfig = {
    ...current,
    ...patch,
    ollama: { ...current.ollama, ...(patch.ollama ?? {}) },
    llama: { ...current.llama, ...(patch.llama ?? {}) },
    anthropic: { ...current.anthropic, ...(patch.anthropic ?? {}) },
    openai: { ...current.openai, ...(patch.openai ?? {}) },
    openaiCompatible: { ...current.openaiCompatible, ...(patch.openaiCompatible ?? {}) },
    gemini: { ...current.gemini, ...(patch.gemini ?? {}) },
    mistral: { ...current.mistral, ...(patch.mistral ?? {}) },
    chatModels: {
      ...current.chatModels,
      ...(patch.chatModels ?? {}),
      llama: { ...current.chatModels.llama, ...(patch.chatModels?.llama ?? {}) },
    },
    configWarnings: [],
  };

  if (typeof merged.dataRoot !== 'string' || merged.dataRoot.trim().length === 0) {
    throw new Error('Invalid dataRoot in config patch.');
  }
  if (!isPositiveInt(merged.port) || merged.port > 65535) {
    throw new Error('Invalid port in config patch.');
  }
  if (!isPositiveInt(merged.sessionConcurrency)) {
    throw new Error('Invalid sessionConcurrency in config patch.');
  }
  if (typeof merged.claudeBin !== 'string' || merged.claudeBin.trim().length === 0) {
    throw new Error('Invalid claudeBin in config patch.');
  }
  if (!isValidProvider(merged.provider)) {
    throw new Error('Invalid provider in config patch.');
  }
  if (!isValidBaseUrl(merged.ollama.baseUrl)) {
    throw new Error('Invalid ollama.baseUrl in config patch.');
  }
  if (typeof merged.ollama.model !== 'string' || merged.ollama.model.trim().length === 0) {
    throw new Error('Invalid ollama.model in config patch.');
  }
  if (!isValidBaseUrl(merged.llama.baseUrl)) {
    throw new Error('Invalid llama.baseUrl in config patch.');
  }
  if (typeof merged.llama.binPath !== 'string' || merged.llama.binPath.trim().length === 0) {
    throw new Error('Invalid llama.binPath in config patch.');
  }
  if (typeof merged.llama.modelPath !== 'string') {
    throw new Error('Invalid llama.modelPath in config patch.');
  }
  if (typeof merged.claudeModel !== 'string') {
    throw new Error('Invalid claudeModel in config patch.');
  }
  if (typeof merged.chatModels.claude !== 'string' || typeof merged.chatModels.ollama !== 'string') {
    throw new Error('Invalid chatModels in config patch.');
  }
  for (const kind of remoteProviderKinds) {
    const section = remoteSectionOf[kind];
    if (!isValidBaseUrl(merged[section].baseUrl)) {
      throw new Error(`Invalid ${section}.baseUrl in config patch.`);
    }
    if (typeof merged[section].model !== 'string') {
      throw new Error(`Invalid ${section}.model in config patch.`);
    }
    if (typeof merged.chatModels[section] !== 'string') {
      throw new Error(`Invalid chatModels.${section} in config patch.`);
    }
  }
  if (typeof merged.chatModels.llama.modelPath !== 'string') {
    throw new Error('Invalid chatModels.llama.modelPath in config patch.');
  }
  // WHY this one is checked where the model names are not: a chat model file for
  // llama.cpp means a SECOND llama-server, and the app dials this address to start it.
  // An address it cannot reach fails at the first learner message instead of here.
  if (!isValidBaseUrl(merged.chatModels.llama.baseUrl)) {
    throw new Error('Invalid chatModels.llama.baseUrl in config patch.');
  }

  const dataRoot = path.resolve(merged.dataRoot);
  mkdirSync(dataRoot, { recursive: true });
  const filePath = configFilePath(dataRoot);
  const toWrite: Omit<AppConfig, 'configWarnings'> = {
    dataRoot: merged.dataRoot,
    port: merged.port,
    sessionConcurrency: merged.sessionConcurrency,
    claudeBin: merged.claudeBin,
    claudeModel: merged.claudeModel,
    provider: merged.provider,
    ollama: merged.ollama,
    llama: merged.llama,
    anthropic: merged.anthropic,
    openai: merged.openai,
    openaiCompatible: merged.openaiCompatible,
    gemini: merged.gemini,
    mistral: merged.mistral,
    chatModels: merged.chatModels,
  };
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmpPath, 'w');
  try {
    writeSync(fd, JSON.stringify(toWrite, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, filePath);
  if (process.platform !== 'win32') {
    const dirFd = openSync(path.dirname(filePath), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }

  resetConfigCache();
  cachedConfig = merged;
  return merged;
}
