// FRACTAL: implements F6 | component C2
import { spawn } from 'node:child_process';
import { loadConfig } from '@/core/config';
import { planLaunch } from './launch';
import { checkOllamaAvailable } from './ollama';
import { checkLlamaAvailable } from './llama';
import { checkOpenAiAvailable } from './openai';
import { checkAnthropicAvailable } from './anthropic';
import { checkGeminiAvailable } from './gemini';
import { remoteSettingsFor } from '@/core/models';
import type { RemoteProviderConfig, RemoteProviderKind } from '@/shapes';
import { isRemoteProvider } from '@/shapes';

const PROBE_TIMEOUT_MS = 5000;

export type ClaudeAvailability =
  | { ok: true; version: string }
  | { ok: false; reason: 'missing' | 'unusable'; message: string };

/**
 * The one place a hosted provider becomes a probe.
 *
 * WHY it is exported rather than inlined into the dispatch below: the Settings screen has
 * to probe the CHAT model of the same provider, which is the same question about a
 * different `RemoteProviderConfig` — and a second copy of this three-way branch is the
 * copy that would be missing the sixth provider.
 */
export async function checkRemoteAvailable(
  provider: RemoteProviderKind,
  settings: RemoteProviderConfig,
): Promise<ClaudeAvailability> {
  if (provider === 'anthropic') return checkAnthropicAvailable(settings);
  if (provider === 'gemini') return checkGeminiAvailable(settings);
  return checkOpenAiAvailable(provider, settings);
}

/**
 * WHY it dispatches on the provider: every caller is asking "can a session run?", not
 * "is the Claude binary here?". With Ollama selected, probing the CLI would report a
 * healthy install as broken — or, worse, an unhealthy one as fine.
 */
export async function checkClaudeAvailable(): Promise<ClaudeAvailability> {
  const config = loadConfig();
  if (config.provider === 'ollama') return checkOllamaAvailable();
  if (config.provider === 'llama') return checkLlamaAvailable();
  if (isRemoteProvider(config.provider)) {
    return checkRemoteAvailable(config.provider, remoteSettingsFor(config, config.provider, 'planning'));
  }
  const claudeBin = config.claudeBin;
  return new Promise<ClaudeAvailability>((resolve) => {
    let settled = false;
    const finish = (result: ClaudeAvailability): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      // WHY planLaunch: the probe must reach a Windows `claude.cmd` shim too,
      // otherwise availability always reports 'missing' on Windows.
      const plan = planLaunch(claudeBin, ['--version']);
      child = spawn(plan.command, plan.args, {
        shell: false,
        windowsVerbatimArguments: plan.verbatim,
      });
    } catch {
      finish({
        ok: false,
        reason: 'missing',
        message: 'The Claude CLI is not installed or not on PATH.',
      });
      return;
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        ok: false,
        reason: 'unusable',
        message: 'The Claude CLI did not respond in time.',
      });
    }, PROBE_TIMEOUT_MS);

    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e.code === 'ENOENT') {
        finish({
          ok: false,
          reason: 'missing',
          message: 'The Claude CLI is not installed or not on PATH.',
        });
      } else {
        finish({
          ok: false,
          reason: 'unusable',
          message: 'The Claude CLI could not be started.',
        });
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim().length > 0) {
        finish({ ok: true, version: stdout.trim() });
      } else {
        finish({
          ok: false,
          reason: 'unusable',
          message: 'The Claude CLI is installed but did not report a version.',
        });
      }
    });
  });
}
