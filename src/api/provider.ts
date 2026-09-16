// FRACTAL: implements F1, F6 | component C9
import { loadConfig, saveConfig, type ConfigPatch } from '@/core/config';
import type { AppConfig, ProviderKind, RemoteProviderConfig } from '@/shapes';
import { checkClaudeAvailable, checkRemoteAvailable } from '@/cli/availability';
import { checkLlamaAvailable } from '@/cli/llama';
import { checkOllamaAvailable } from '@/cli/ollama';
import { llamaSettingsFor, ollamaSettingsFor, remoteSettingsFor } from '@/core/models';
import { keyEnvVarFor, hasApiKey } from '@/core/keys';
import { transportFor, unwrapCliOutput } from '@/cli/run-session';
import { err } from '@/core/errors';
import {
  isRemoteProvider,
  leavesThisMachine,
  remoteSectionOf,
  providerName,
  providerViewSchema,
  providerTestResultSchema,
  type ProviderTestResult,
  type ProviderUpdate,
  type ProviderView,
} from '@/shapes';

/**
 * Where this provider lives and which model it runs, as the one shared Settings form asks
 * it.
 *
 * WHY one baseUrl/model pair for eight providers: the screen asks the same two questions
 * of every one of them — where the server is, and which model it serves — and the only
 * differences are what those answers look like. llama.cpp answers the second with a file
 * rather than a name; the Claude CLI has no address at all, because there is no server for
 * the learner to point at. One pair of fields keeps the screen honest about that without
 * eight forms.
 */
function addressOf(config: AppConfig): { baseUrl: string; model: string } {
  const provider = config.provider;
  if (provider === 'llama') return { baseUrl: config.llama.baseUrl, model: config.llama.modelPath };
  if (provider === 'ollama') return { baseUrl: config.ollama.baseUrl, model: config.ollama.model };
  if (isRemoteProvider(provider)) {
    const section: RemoteProviderConfig = config[remoteSectionOf[provider]];
    return { baseUrl: section.baseUrl, model: section.model };
  }
  // WHY '' and not the Ollama address: the CLI resolves its own endpoint from the
  // learner's own login, so there is nothing here they could set. Showing some other
  // provider's address in the box would be the screen inventing a setting.
  return { baseUrl: '', model: config.claudeModel };
}

/**
 * The chat-role override as the shared form shows it: one model field, plus an address
 * that only llama.cpp needs (a second model there means a second server).
 */
function chatAddressOf(config: AppConfig): { chatModel: string; chatBaseUrl: string } {
  const provider = config.provider;
  if (provider === 'llama') {
    return { chatModel: config.chatModels.llama.modelPath, chatBaseUrl: config.chatModels.llama.baseUrl };
  }
  const chatModel = isRemoteProvider(provider)
    ? config.chatModels[remoteSectionOf[provider]]
    : provider === 'ollama'
      ? config.chatModels.ollama
      : config.chatModels.claude;
  return { chatModel, chatBaseUrl: config.chatModels.llama.baseUrl };
}

/**
 * WHY the chat model is probed separately and folded into the same verdict: a chat model
 * that is not installed does not break anything until the learner is mid-conversation and
 * the tutor goes silent — which is the exact surprise this screen's probe exists to catch.
 * "Ready" has to mean both roles can run, so a chat-only failure is still not-ready, and
 * its message says which role failed.
 */
async function probeChat(config: AppConfig): Promise<{ ok: boolean; message: string | null }> {
  const provider = config.provider;
  if (provider === 'ollama') {
    if (config.chatModels.ollama.trim().length === 0) return { ok: true, message: null };
    const probe = await checkOllamaAvailable(ollamaSettingsFor(config, 'chat'));
    return { ok: probe.ok, message: probe.ok ? null : `Chat model: ${probe.message}` };
  }
  if (provider === 'llama') {
    if (config.chatModels.llama.modelPath.trim().length === 0) return { ok: true, message: null };
    const probe = await checkLlamaAvailable(true, llamaSettingsFor(config, 'chat'));
    return { ok: probe.ok, message: probe.ok ? null : `Chat model: ${probe.message}` };
  }
  if (isRemoteProvider(provider)) {
    if (config.chatModels[remoteSectionOf[provider]].trim().length === 0) return { ok: true, message: null };
    const probe = await checkRemoteAvailable(provider, remoteSettingsFor(config, provider, 'chat'));
    return { ok: probe.ok, message: probe.ok ? null : `Chat model: ${probe.message}` };
  }
  // WHY nothing to probe for Claude: the CLI resolves `--model` itself, and there is no
  // local server whose absence this screen could report or repair.
  return { ok: true, message: null };
}

export async function providerView(): Promise<ProviderView> {
  const config = loadConfig();
  // WHY this screen starts the server and the health panel does not: the learner is here
  // BECAUSE they are choosing a local provider, and "start it yourself first" would be
  // the app asking for something it can do. Elsewhere the same probe only reports.
  const probe = config.provider === 'llama' ? await checkLlamaAvailable(true) : await checkClaudeAvailable();
  const chat = await probeChat(config);
  const address = addressOf(config);
  return providerViewSchema.parse({
    provider: config.provider,
    ...address,
    ...chatAddressOf(config),
    available: probe.ok && chat.ok,
    message: probe.ok ? chat.message : probe.message,
    // WHY the name of the variable and never its value: a key lives in the environment and
    // nowhere else, so the only two honest things to say about it are where it is read
    // from and whether it is there.
    keyEnvVar: keyEnvVarFor(config.provider),
    keySet: hasApiKey(config.provider),
    // WHY `leavesThisMachine` and not `isRemoteProvider`: an OpenAI-compatible server on
    // 127.0.0.1 is a private setup with a hosted provider's name, and telling that learner
    // their words are leaving would be a warning about something that is not happening.
    remote: leavesThisMachine(config.provider, address.baseUrl),
  });
}

/**
 * The address and chat-model edits written to the section the CHOSEN provider owns.
 *
 * WHY it is one function keyed off the provider rather than an if-chain at the save site:
 * the one form is shared, so saving while llama.cpp is selected must not overwrite the
 * Ollama address with a .gguf path the Ollama probe would then dial — and the same is true
 * of every pair of hosted providers. Deriving the section from the provider is what makes
 * that structural instead of remembered.
 */
function patchFor(update: ProviderUpdate, current: AppConfig): ConfigPatch {
  const chatModels: ConfigPatch['chatModels'] = {};
  if (update.chatBaseUrl !== undefined && update.chatBaseUrl.length > 0) {
    chatModels.llama = { baseUrl: update.chatBaseUrl };
  }
  const patch: ConfigPatch = { provider: update.provider, chatModels };

  if (update.provider === 'llama') {
    if (update.chatModel !== undefined) chatModels.llama = { ...chatModels.llama, modelPath: update.chatModel };
    patch.llama = {
      ...current.llama,
      baseUrl: update.baseUrl ?? current.llama.baseUrl,
      modelPath: update.model ?? current.llama.modelPath,
    };
    return patch;
  }
  if (update.provider === 'ollama') {
    if (update.chatModel !== undefined) chatModels.ollama = update.chatModel;
    patch.ollama = {
      baseUrl: update.baseUrl ?? current.ollama.baseUrl,
      model: update.model ?? current.ollama.model,
    };
    return patch;
  }
  if (isRemoteProvider(update.provider)) {
    const section = remoteSectionOf[update.provider];
    if (update.chatModel !== undefined) chatModels[section] = update.chatModel;
    patch[section] = {
      baseUrl: update.baseUrl ?? current[section].baseUrl,
      model: update.model ?? current[section].model,
    };
    return patch;
  }
  if (update.chatModel !== undefined) chatModels.claude = update.chatModel;
  // WHY the model is all the CLI takes: it has no address to set, and `claudeBin` is a
  // path on this machine that Settings deliberately does not put behind a text box.
  patch.claudeModel = update.model ?? current.claudeModel;
  return patch;
}

/**
 * WHY it re-probes after saving rather than before: the learner is usually changing the
 * URL or the model *because* the current one is wrong, so the answer that matters is
 * whether the new combination works. The probe never blocks the save — a provider that
 * is merely not running yet is a normal state to be configured in.
 */
export async function updateProvider(update: ProviderUpdate): Promise<ProviderView> {
  const current = loadConfig();
  try {
    saveConfig(patchFor(update, current));
  } catch (e) {
    throw err('validation', {
      detail: e instanceof Error ? e.message : String(e),
      userMessage: 'That provider setting could not be saved — check the server address and model name.',
    });
  }
  return providerView();
}

/**
 * WHY the whole prompt and not just a ping: the question this button answers is "will a
 * lesson come back", and a reachable server that refuses the model, rejects the key or
 * answers with prose is a failure the learner needs to see here rather than at the end of
 * their first lesson. It is deliberately the smallest possible generation.
 */
const TEST_PROMPT =
  'Say hello.\n\nOUTPUT CONTRACT\nReply with exactly this JSON object and nothing else: {"ok": true}';
const TEST_SYSTEM = 'You answer with one JSON object and nothing else.';

/** WHY it is generous: a model on this computer loads several gigabytes before it can
 *  answer anything at all, and reporting that as a failure would be wrong. */
const TEST_TIMEOUT_MS = 5 * 60 * 1000;

function testArgv(config: AppConfig): string[] {
  return [
    '-p',
    '--system-prompt',
    TEST_SYSTEM,
    '--setting-sources',
    '',
    '--strict-mcp-config',
    ...(config.claudeModel.trim().length === 0 ? [] : ['--model', config.claudeModel.trim()]),
    '--output-format',
    'json',
    '--max-turns',
    '1',
  ];
}

/** WHY a name and not a label: this is the sentence the learner reads, and "the
 *  openai-compatible provider" is a config value, not a thing they chose. */
function friendlyName(provider: ProviderKind): string {
  return providerName(provider);
}

/**
 * One real call to the provider that is configured right now.
 *
 * WHY it goes through the very transport a session uses: a test that dialled the endpoint
 * itself would prove the endpoint answers and nothing about whether this app can talk to
 * it — which is the only question worth a button. Every adapter is exercised through the
 * same `CliTransport` seam the runner uses, so a provider cannot pass this and then fail
 * on the first lesson for a reason the test never touched.
 */
export async function testProvider(): Promise<ProviderTestResult> {
  const config = loadConfig();
  const name = friendlyName(config.provider);
  const started = Date.now();
  const transport = transportFor(config, 'planning');

  return new Promise<ProviderTestResult>((resolve) => {
    let settled = false;
    let stdout = '';
    let handle: ReturnType<typeof transport.spawn>;

    const finish = (ok: boolean, message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        handle.kill('SIGTERM');
      } catch {
        // already gone
      }
      resolve(providerTestResultSchema.parse({ ok, message }));
    };

    const timer = setTimeout(() => {
      finish(false, `${name} did not answer within five minutes.`);
    }, TEST_TIMEOUT_MS);

    try {
      handle = transport.spawn(config.claudeBin, testArgv(config), {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          USERPROFILE: process.env.USERPROFILE ?? '',
        },
      });
    } catch {
      clearTimeout(timer);
      settled = true;
      resolve(providerTestResultSchema.parse({ ok: false, message: `${name} could not be started.` }));
      return;
    }

    handle.onError(() => finish(false, `${name} could not be reached.`));
    handle.onStdout((chunk) => {
      if (stdout.length < 200_000) stdout += chunk.toString('utf8');
    });
    handle.onExit(() => {
      if (settled) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        finish(false, `${name} answered with something we could not read.`);
        return;
      }
      const unwrapped = unwrapCliOutput(parsed);
      if (!unwrapped.ok) {
        const envelope = parsed as { is_error?: unknown; result?: unknown };
        const detail = typeof envelope.result === 'string' ? envelope.result.trim() : '';
        // WHY the provider's own words are passed through when it reported the failure: a
        // rejected key, an unknown model id and a rate limit are three different repairs,
        // and only the provider knows which one happened. An answer that merely came back
        // in the wrong shape is this app's complaint, not theirs, so it is worded here.
        if (envelope.is_error === true) {
          finish(false, detail.length === 0 ? `${name} did not answer.` : detail.slice(0, 300));
        } else {
          finish(false, `${name} answered, but not in the form this app needs.`);
        }
        return;
      }
      finish(true, `${name} answered in ${Date.now() - started}ms.`);
    });

    handle.write(TEST_PROMPT);
    handle.endStdin();
  });
}
