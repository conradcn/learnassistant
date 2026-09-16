// FRACTAL: implements F1 | component C9
import { APP_VERSION } from '@/api/version';
import { loadConfig } from '@/core/config';
import { checkClaudeAvailable } from '@/cli/availability';
import { services, storeFailure } from '@/api/services';
import { pathDigest } from '@/api/token';
import { healthViewSchema, type HealthView } from '@/api/shapes';
import type { AppConfig } from '@/shapes';

/** WHY a function: "which model" is a different field per provider — a name for Ollama,
 *  a file for llama.cpp, and nothing at all for Claude, whose model the CLI chooses. */
function providerModelOf(config: AppConfig): string | null {
  if (config.provider === 'ollama') return config.ollama.model;
  if (config.provider === 'llama') return config.llama.modelPath.split(/[\/]/).pop() ?? null;
  return null;
}

/** WHY (H1/H5): every field here is a boolean, a count, a version or a digest. The
 *  per-launch token is deliberately absent, and so is the data-root path — only the
 *  recovery route serves that, and only to the screen that must name it. */
export async function healthView(): Promise<HealthView> {
  const config = loadConfig();
  const ready = services();
  const failed = storeFailure();
  const cli = await checkClaudeAvailable();
  const warnings = [...config.configWarnings];
  if (failed !== null) warnings.push('Your saved data could not be opened.');
  // WHY: an unreachable provider is the single most common reason nothing generates,
  // and its own explanation ("run `ollama pull ...`") is far more useful than the bare
  // "unavailable" flag the cli field can carry.
  if (!cli.ok) warnings.push(cli.message);
  const view: HealthView = {
    appVersion: APP_VERSION,
    schemaVersion: ready === null ? 0 : ready.store.health().schemaVersion,
    cli: cli.ok
      ? { available: true, version: cli.version, message: null }
      : { available: false, version: null, message: cli.message },
    provider: config.provider,
    providerModel: providerModelOf(config),
    degradedTopicCount: ready === null ? 0 : ready.store.health().degradedTopicCount,
    configWarnings: warnings,
    dataRootDigest: pathDigest(config.dataRoot),
  };
  return healthViewSchema.parse(view);
}
