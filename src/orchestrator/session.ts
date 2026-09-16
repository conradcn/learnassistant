// FRACTAL: implements F2, F12 | component C4
import type { z } from 'zod';
import {
  sessionIdSchema,
  type CliSessionResult,
  type ModuleId,
  type SessionId,
  type TopicId,
} from '@/shapes';
import { randomBytes, randomUUID } from 'node:crypto';
import { log } from '@/core/log';
import { loadConfig } from '@/core/config';
import { err, type AppError } from '@/core/errors';
import type { SessionRunner } from '@/cli/run-session';
import { buildPrompt, type ModuleBrief, type SessionKind } from '@/cli/prompt';
import type { Store } from '@/store/open';
import { discardOrphanDirectory, ensureModuleDir } from '@/orchestrator/reconcile';

export const AUTHORING_TOOLS: readonly string[] = ['Read', 'Write', 'Edit'];
export const READ_ONLY_TOOLS: readonly string[] = ['Read'];

export type OrchestratorDeps = {
  store: Store;
  runner: SessionRunner;
  dataRoot: string;
};

export type DispatchRequest = {
  kind: SessionKind;
  topicId: TopicId;
  workspaceModuleId: ModuleId;
  ephemeralWorkspace?: boolean;
  brief: ModuleBrief;
  /**
   * Names a conversation this session is a turn in. When one is already live, only
   * `turnPrompt` is sent and the CLI supplies the rest from its own transcript; when it
   * is not, `brief` opens it as before and the conversation is remembered for next time.
   */
  conversation?: { key: string; turnPrompt: string };
  outputSchema: z.ZodTypeAny;
  timeoutMs: number;
  maxTurns: number;
  allowedTools: readonly string[];
  signal: AbortSignal;
};

export type DispatchOutcome =
  | { ok: true; output: unknown; durationMs: number; sessionId: SessionId | null }
  | { ok: false; code: string; message: string; correlationId: string };

function newSessionId(): SessionId {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(16);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return sessionIdSchema.parse(`s_${out}`);
}

function toOutcome(result: CliSessionResult): DispatchOutcome {
  if (result.ok) {
    return { ok: true, output: result.output, durationMs: result.durationMs, sessionId: result.id };
  }
  return { ok: false, code: result.code, message: result.message, correlationId: result.correlationId };
}

// WHY there is a cap and not a lifetime: a forgotten conversation costs nothing but a
// re-opened one, and the CLI's own transcripts expire on their own schedule regardless of
// what this map believes. The cap is what keeps a long-running app from holding an entry
// per conversation ever opened; the oldest is dropped first because the learner in front
// of you is the one whose next turn has to be fast.
const MAX_LIVE_CONVERSATIONS = 64;

/**
 * WHY the map lives on `globalThis` behind a symbol and not at module scope: module scope
 * is not process scope. `src/api/services.ts` already carries the same cell for the same
 * observed reason — separate route bundles each got their own copy of the module, so state
 * one bundle wrote was invisible to the next. A capstone submission and its follow-up
 * landing in different bundles would lose the uuid, `resumedUuid` would be null, and the
 * turn would re-open with the full brief — the exact cost the note above exists to avoid.
 */
const CELL = Symbol.for('learn-assistant.orchestrator.conversations');

function liveConversations(): Map<string, string> {
  const host = globalThis as unknown as Record<symbol, Map<string, string> | undefined>;
  const existing = host[CELL];
  if (existing !== undefined) return existing;
  const fresh = new Map<string, string>();
  host[CELL] = fresh;
  return fresh;
}

/**
 * WHY only the Claude provider: `--resume` is a Claude CLI feature. The Ollama and llama
 * transports are stateless HTTP calls that ignore the argv entirely, so a turn prompt sent
 * to one would arrive with no lesson, no criteria and no transcript — the optimisation
 * would silently become a bug. They keep sending the whole brief.
 */
function conversationsAvailable(): boolean {
  try {
    return loadConfig().provider === 'claude';
  } catch {
    return false;
  }
}

export function forgetConversation(key: string): void {
  liveConversations().delete(key);
}

function rememberConversation(key: string, uuid: string): void {
  const live = liveConversations();
  live.delete(key);
  live.set(key, uuid);
  while (live.size > MAX_LIVE_CONVERSATIONS) {
    const oldest = live.keys().next();
    if (oldest.done === true) break;
    live.delete(oldest.value);
  }
}

// WHY it is still the one door: every model call in this component funnels through here,
// so the workspace, the prompt, the conversation resume and the cancellation contract are
// written once. It no longer asks anyone's permission — the learner's click on the control
// that named this work is the authorisation, and there is nothing between the two.
export async function dispatchSession(deps: OrchestratorDeps, req: DispatchRequest): Promise<DispatchOutcome> {
  if (req.signal.aborted) {
    return { ok: false, code: 'cancelled', message: 'That was cancelled.', correlationId: 'c_cancelled' };
  }

  const moduleDir = ensureModuleDir(deps.dataRoot, req.topicId, req.workspaceModuleId);
  const built = buildPrompt({ kind: req.kind, brief: req.brief });
  const started = Date.now();

  const useConversation = req.conversation !== undefined && conversationsAvailable();
  const key = req.conversation?.key ?? '';
  const resumedUuid = useConversation ? (liveConversations().get(key) ?? null) : null;

  // WHY the abort listener is registered per attempt: each attempt is a distinct process
  // with a distinct id, and a listener holding the first id would cancel nothing once the
  // fallback attempt is the one running.
  const attempt = async (uuid: string | null, resume: boolean): Promise<CliSessionResult> => {
    const id = newSessionId();
    const onAbort = (): void => deps.runner.cancel(id);
    req.signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await deps.runner.run(
        {
          id,
          kind: req.kind,
          moduleDir,
          prompt: resume && req.conversation !== undefined ? req.conversation.turnPrompt : built.prompt,
          allowedTools: [...req.allowedTools],
          timeoutMs: req.timeoutMs,
          maxTurns: req.maxTurns,
          ...(uuid === null ? {} : { conversation: { uuid, resume } }),
        },
        req.outputSchema,
      );
    } finally {
      req.signal.removeEventListener('abort', onAbort);
    }
  };

  try {
    let result: CliSessionResult;
    if (resumedUuid !== null) {
      result = await attempt(resumedUuid, true);
      // WHY the retry: the CLI is the owner of its transcripts, and it can drop one for
      // reasons this app never sees — a cleared history, an expiry, a different machine.
      // A resume that fails must not become a dead conversation the learner has to
      // abandon, so the fallback is exactly the session that would have run before this
      // optimisation existed: the full brief, a fresh id.
      if (!result.ok && !req.signal.aborted) {
        forgetConversation(key);
        log({ level: 'warn', event: 'orchestrator-conversation-lost', component: 'C4', kind: req.kind, code: result.code });
        const fresh = randomUUID();
        result = await attempt(fresh, false);
        if (result.ok) rememberConversation(key, fresh);
      }
    } else if (useConversation) {
      const fresh = randomUUID();
      result = await attempt(fresh, false);
      if (result.ok) rememberConversation(key, fresh);
    } else {
      result = await attempt(null, false);
    }
    log({
      level: 'info',
      event: 'orchestrator-session-finished',
      component: 'C4',
      kind: req.kind,
      topicId: req.topicId,
      ok: result.ok,
      durationMs: Date.now() - started,
      resumed: resumedUuid !== null,
    });
    return toOutcome(result);
  } finally {
    if (req.ephemeralWorkspace === true) {
      discardOrphanDirectory(deps.dataRoot, req.topicId, req.workspaceModuleId);
    }
  }
}

export function sessionError(outcome: Extract<DispatchOutcome, { ok: false }>): AppError {
  return err('cli-failed', { detail: `session failed: ${outcome.code}`, userMessage: outcome.message });
}
