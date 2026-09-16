// FRACTAL: implements F6 | component C2
import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import { planLaunch } from './launch';
import { OllamaTransport } from './ollama';
import { LlamaTransport } from './llama';
import { OpenAiTransport, openAiLabel } from './openai';
import { AnthropicTransport } from './anthropic';
import { GeminiTransport } from './gemini';
import { takeWorkspaceWrites, withWorkspace } from './workspace';
import { realpathSync } from 'node:fs';
import { contractIssuesOf } from '@/core/contract-issues';
import { z } from 'zod';
import type { AppConfig, CliSessionResult, CliSessionSpec, ProviderKind, SessionId } from '@/shapes';
import { isRemoteProvider, leavesThisMachine } from '@/shapes';
import { paths, isContained } from '@/core/paths';
import { loadConfig } from '@/core/config';
import {
  claudeModelFor,
  llamaSettingsFor,
  ollamaSettingsFor,
  remoteSettingsFor,
  roleOfKind,
  type SessionRole,
} from '@/core/models';
import { newCorrelationId } from '@/core/errors';
import { log } from '@/core/log';
import { Semaphore, type SessionPriority } from '@/cli/semaphore';

export type SpawnOptions = { cwd: string; env: Record<string, string> };

/**
 * WHY it reuses the chat/planning split: the kinds whose prompt is a turn in a conversation
 * a learner is waiting through are exactly the kinds `roleOfKind` calls `chat`. Naming the
 * same set twice would let the two drift, and the one that mattered less would be the one
 * left behind.
 */
function priorityOf(kind: CliSessionSpec['kind']): SessionPriority {
  return roleOfKind(kind) === 'chat' ? 'interactive' : 'background';
}

export interface CliChildHandle {
  readonly pid: number | undefined;
  write(data: string): void;
  endStdin(): void;
  onStdout(cb: (chunk: Buffer) => void): void;
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(cb: (err: Error) => void): void;
  kill(signal: NodeJS.Signals): void;
}

export interface CliTransport {
  spawn(bin: string, argv: string[], opts: SpawnOptions): CliChildHandle;
}

type FailureResult = Extract<CliSessionResult, { ok: false }>;
type FailureCode = FailureResult['code'];

// WHY: buildArgv asks for `--output-format json`, so the CLI is silent until the whole
// session is done — "no output yet" is the normal state, not a stall. A 90s budget was
// therefore a 90s hard cap, and it killed every authoring session mid-write. The budget
// has to exceed a plausible session, with OVERALL_TIMEOUT_MS (1h) as the real backstop.
const STALL_MS_DEFAULT = 10 * 60 * 1000;
const KILL_GRACE_MS = 5_000;
// WHY: the per-request budgets (120s for an evaluation turn, 10min for authoring) are
// sized for a hosted model answering in seconds. A local model on consumer hardware
// spends that long on the first token alone, so with Ollama selected those budgets are
// floors, not caps — every local session gets at least this long before it is killed.
// Without it an evaluation turn on Ollama times out before the model has finished
// thinking, which reads to the learner as "the evaluator went silent".
export const LOCAL_MIN_TIMEOUT_MS = 15 * 60 * 1000;

/** WHY one predicate: every budget, message and transport decision below turns on the
 *  same question — is the model on this machine? — and asking it once is what keeps a
 *  third local provider from having to be remembered in four places. */
export function isLocalProvider(provider: ProviderKind): boolean {
  return provider === 'ollama' || provider === 'llama';
}

/**
 * Whether the model this session will reach is running on this machine — which is the
 * question the timeout budgets below actually turn on.
 *
 * WHY it is not `isLocalProvider`: `openai-compatible` pointed at LM Studio on 127.0.0.1
 * is a local model with a hosted provider's name, and giving it a hosted provider's
 * budgets kills it mid-lesson exactly the way Ollama used to be killed.
 */
function runsOnThisMachine(config: AppConfig, role: SessionRole): boolean {
  if (isLocalProvider(config.provider)) return true;
  if (!isRemoteProvider(config.provider)) return false;
  return !leavesThisMachine(config.provider, remoteSettingsFor(config, config.provider, role).baseUrl);
}

/** The one sentence to show when a provider could not be reached at all. */
function providerMissingMessage(config: AppConfig, role: SessionRole): string {
  if (config.provider === 'ollama') return `No Ollama server answered at ${ollamaSettingsFor(config, role).baseUrl}.`;
  if (config.provider === 'llama') {
    return `No llama.cpp server could be started at ${llamaSettingsFor(config, role).baseUrl}.`;
  }
  if (isRemoteProvider(config.provider)) {
    const settings = remoteSettingsFor(config, config.provider, role);
    return `${providerLabel(config.provider)} could not be reached at ${settings.baseUrl}.`;
  }
  return 'The Claude CLI is not installed or not on PATH.';
}

/** How each provider is named in a message a learner reads. */
export function providerLabel(provider: ProviderKind): string {
  if (provider === 'anthropic') return 'Anthropic';
  if (provider === 'gemini') return 'Gemini';
  if (provider === 'ollama') return 'Ollama';
  if (provider === 'llama') return 'llama.cpp';
  if (provider === 'claude') return 'The Claude CLI';
  return openAiLabel(provider);
}

/**
 * Whether this provider opens and saves files itself.
 *
 * WHY it is the one question that decides whether `withWorkspace` runs: the `claude` CLI
 * is given `--add-dir` and a Read/Write/Edit allowlist and does its own file access inside
 * that box. Every other provider here — hosted or local, it makes no difference — is a
 * chat endpoint with no file tools at all, so the module directory has to be carried into
 * the prompt and the answer's files written back out for it (see src/cli/workspace.ts).
 * Asking "is it remote" instead would have quietly left Ollama and llama.cpp unable to see
 * a module directory they are just as entitled to.
 */
function hasFileTools(provider: ProviderKind): boolean {
  return provider === 'claude';
}

const MAX_STDOUT_BYTES = 1_000_000;

class RealChildHandle implements CliChildHandle {
  readonly pid: number | undefined;
  private readonly child: ReturnType<typeof nodeSpawn>;

  constructor(bin: string, argv: string[], opts: SpawnOptions) {
    // WHY planLaunch: a Windows `claude.cmd` shim cannot be spawned directly. See
    // src/cli/launch.ts — shell interpolation is still never enabled.
    const plan = planLaunch(bin, argv);
    this.child = nodeSpawn(plan.command, plan.args, {
      cwd: opts.cwd,
      // WHY: Next's type augmentation makes NODE_ENV required on ProcessEnv, but the
      // child is deliberately given a minimal environment that does not carry it.
      env: opts.env as NodeJS.ProcessEnv,
      shell: false,
      windowsVerbatimArguments: plan.verbatim,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pid = this.child.pid;
    // WHY: a child that exits before the prompt is written turns the very next
    // stdin write into an EPIPE. A writable stream with no 'error' listener emits
    // that as an unhandled 'error' event, which is a hard process-level throw —
    // not something the surrounding session promise could ever catch. The exit
    // path already reports the failure, so the write error only needs absorbing.
    this.child.stdin?.on('error', () => {});
  }

  write(data: string): void {
    if (this.child.stdin?.writable !== true) return;
    this.child.stdin.write(data);
  }

  endStdin(): void {
    if (this.child.stdin?.writable !== true) return;
    this.child.stdin.end();
  }

  onStdout(cb: (chunk: Buffer) => void): void {
    this.child.stdout?.on('data', cb);
  }

  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.child.on('exit', (code, signal) => cb(code, signal));
  }

  onError(cb: (err: Error) => void): void {
    this.child.on('error', cb);
  }

  kill(signal: NodeJS.Signals): void {
    if (this.pid === undefined) return;
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/pid', String(this.pid), '/t', '/f'], { stdio: 'ignore' });
      } catch {
        try {
          this.child.kill(signal);
        } catch {
          // process may already be gone
        }
      }
      return;
    }
    try {
      process.kill(-this.pid, signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        // process may already be gone
      }
    }
  }
}

class RealTransport implements CliTransport {
  spawn(bin: string, argv: string[], opts: SpawnOptions): CliChildHandle {
    return new RealChildHandle(bin, argv, opts);
  }
}

/**
 * WHY: `--output-format json` wraps the model's answer in a CLI envelope
 * ({type:'result', result:"<text>"}) — the lesson itself is the string in `result`,
 * often inside a ``` fence. Handing the envelope straight to the content validator
 * meant every authored module was rejected as "not in a form we could save". A
 * payload that is already the bare object (fakes in tests, future formats) passes
 * through untouched.
 */
export function unwrapCliOutput(parsed: unknown): { ok: true; output: unknown } | { ok: false; reason: string } {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: true, output: parsed };
  const envelope = parsed as Record<string, unknown>;
  if (envelope.type !== 'result' || !('result' in envelope)) return { ok: true, output: parsed };
  if (envelope.is_error === true) {
    return { ok: false, reason: 'the CLI reported the session itself as failed' };
  }
  const payload = envelope.result;
  if (typeof payload !== 'string') return { ok: true, output: payload };
  const candidates = jsonCandidates(payload);
  for (const candidate of candidates) {
    try {
      return { ok: true, output: JSON.parse(candidate) };
    } catch {
      // try the next candidate
    }
  }
  // WHY: a 20KB lesson that is complete except for its final `}` is the single most
  // common way authoring fails on a real run — the model writes every block, every
  // learning goal and the whole eval script, then stops one character short. Giving up
  // there throws away a good lesson and costs the learner a session they consented to.
  // Closing what is open is the only repair attempted: nothing already written is
  // rewritten, so a repair can add structure but can never change meaning. Anything
  // genuinely cut off mid-lesson still loses its later required keys and is refused by
  // the content validator downstream, which is where that judgement belongs.
  // WHY only the verbatim and fenced candidates: the brace-slice candidate is already a
  // guess at where the JSON starts and ends, and repairing a guess compounds it — on a
  // lesson cut off mid-sentence it happily closes at some earlier nested brace and hands
  // back a two-key object as though that were the whole answer.
  for (const candidate of repairableCandidates(payload)) {
    const closed = closeUnterminatedJson(candidate);
    if (closed === null) continue;
    try {
      return { ok: true, output: JSON.parse(closed) };
    } catch {
      // the repair did not make it readable either
    }
  }
  return { ok: false, reason: 'the session answered with text that was not the JSON we asked for' };
}

// WHY a ceiling: one or two missing closers is a model dropping the tail of a finished
// answer. A dozen is an answer that stopped in the middle, and inventing the rest of its
// structure would turn "the lesson did not arrive" into "here is a lesson with most of it
// missing" — a silent corruption in place of an honest failure.
const MAX_REPAIRED_CLOSERS = 8;

/**
 * Appends the closers left open by a truncated JSON document, or null when the text is
 * not repairable that way. Exported for the tests that pin the repair's limits.
 */
export function closeUnterminatedJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of trimmed) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  // WHY an unterminated string is refused rather than closed: a model that dropped the
  // tail of a finished answer ends between tokens, never mid-word. Text that stops inside
  // a string stopped in the middle of a sentence, and closing the quote would save a
  // half-written one as though the model had meant it.
  if (inString) return null;
  if (stack.length === 0) return null;
  if (stack.length > MAX_REPAIRED_CLOSERS) return null;
  const closerFor: Record<string, string> = { '{': '}', '[': ']' };
  const tail = stack
    .reverse()
    .map((open) => closerFor[open])
    .join('');
  return `${trimmed}${tail}`;
}

/**
 * WHY: the old reading took the FIRST fenced block and parsed only that. An answer
 * that opened with prose and an unlabelled fence — a graph drawn in ASCII art, say —
 * therefore threw away a perfectly good ```json block further down and reported the
 * whole session as unreadable. Candidates are ordered most- to least-trustworthy so a
 * fence the model explicitly labelled json always wins over a guess at the braces.
 */
function repairableCandidates(payload: string): string[] {
  const out: string[] = [payload.trim()];
  for (const m of payload.matchAll(/```json\s*([\s\S]*?)```/g)) out.push(m[1].trim());
  for (const m of payload.matchAll(/```\s*([\s\S]*?)```/g)) out.push(m[1].trim());
  return out;
}

function jsonCandidates(payload: string): string[] {
  const out: string[] = repairableCandidates(payload);
  const first = payload.indexOf('{');
  const last = payload.lastIndexOf('}');
  if (first !== -1 && last > first) out.push(payload.slice(first, last + 1));
  return out;
}

// WHY: with no --system-prompt the CLI runs its default coding-agent prompt — tool
// preambles, repo conventions, git status, CLAUDE.md memory — none of which describes
// this job. That prompt costs tokens on every session and actively misleads: sessions
// went looking at the surrounding project instead of authoring the module in front of
// them. Overriding it leaves exactly the instruction this app needs; the KIND line and
// the output contract in buildPrompt carry the rest. Kept to ONE line deliberately —
// on Windows the argv goes through cmd.exe (see launch.ts), where a newline inside an
// argument would end the command.
const SESSION_SYSTEM_PROMPT: string =
  'You author and evaluate self-contained learning material. Work only from the single ' +
  'prompt you are given: do not explore the working directory, read project files, or ' +
  'reason about the surrounding codebase. Follow the OUTPUT CONTRACT in the prompt exactly ' +
  'and reply with nothing else.';

// WHY a second one: an `evaluate` session is not a job with an input and an output, it is
// one side of a conversation the learner is sitting in — and now literally so, since the
// turns after the first resume this same CLI conversation rather than restating it. The
// role has to be stated where it survives a resume, which is the system prompt; the user
// messages are then what they claim to be, the learner talking.
const CHAT_SYSTEM_PROMPT: string =
  'You are a tutor talking with one learner about something they have just studied. Your ' +
  'job is to find out whether they can use the idea, not whether they can recite it: ask, ' +
  'listen, probe the weak spot, and only explain once they have tried. Address the learner ' +
  'directly and never narrate what you are doing. Work only from this conversation: do not ' +
  'explore the working directory, read project files, or reason about the surrounding ' +
  'codebase. Every reply is the single JSON object the OUTPUT CONTRACT describes, and ' +
  'nothing else — that contract holds for every turn, not only the first.';


// WHY a third one: an `ask` session is a learner raising their hand in the middle of a
// lesson. Told the evaluator's role it starts probing them, and told the authoring role it
// answers about the module rather than to the person — both are wrong for a question.
const ASK_SYSTEM_PROMPT: string =
  'You are a tutor answering one question from a learner who is part-way through the ' +
  'lesson in the prompt. Answer the thing they asked, briefly and in their own terms, ' +
  'using only that lesson and what it assumes. Do not test them, do not ask them to prove ' +
  'anything, and do not narrate what you are doing. Work only from this prompt: do not ' +
  'explore the working directory, read project files, or reason about the surrounding ' +
  'codebase. Reply with the single JSON object the OUTPUT CONTRACT describes and nothing else.';

// WHY a fourth one: nothing has been taught yet. Given the evaluator's role the model
// grades a stranger; given the tutor's it starts explaining. This one only listens.
const DIAGNOSTIC_SYSTEM_PROMPT: string =
  'You are a tutor meeting a learner before their course is planned, finding out what they ' +
  'already know so it is not taught to them again. Ask one short question at a time, do not ' +
  'teach, correct or grade, and do not narrate what you are doing. Work only from this ' +
  'prompt: do not explore the working directory, read project files, or reason about the ' +
  'surrounding codebase. Reply with the single JSON object the OUTPUT CONTRACT describes and nothing else.';

function systemPromptFor(kind: CliSessionSpec['kind']): string {
  if (kind === 'evaluate') return CHAT_SYSTEM_PROMPT;
  if (kind === 'ask') return ASK_SYSTEM_PROMPT;
  if (kind === 'diagnostic') return DIAGNOSTIC_SYSTEM_PROMPT;
  return SESSION_SYSTEM_PROMPT;
}

/**
 * WHY the two flags are not interchangeable: `--session-id` names a conversation that does
 * not exist yet and `--resume` continues one that does. Passing the wrong one is not a
 * no-op — resuming an unknown id fails the session outright — so the decision is made by
 * the caller that knows whether it has spoken to this conversation before, and the
 * fallback for a conversation the CLI has forgotten lives with it (see dispatchSession).
 */
function conversationArgs(spec: CliSessionSpec): string[] {
  if (spec.conversation === undefined) return [];
  return spec.conversation.resume
    ? ['--resume', spec.conversation.uuid]
    : ['--session-id', spec.conversation.uuid];
}

function buildArgv(spec: CliSessionSpec, model: string | null): string[] {
  return [
    '-p',
    ...conversationArgs(spec),
    '--system-prompt',
    systemPromptFor(spec.kind),
    // WHY: without these the session still inherits the learner's own settings, their
    // CLAUDE.md files and every MCP server they have configured — all of it context
    // about their machine, none of it about the module being written.
    '--setting-sources',
    '',
    '--strict-mcp-config',
    // WHY conditional: with no `--model` the CLI uses the learner's own default, which is
    // the right answer until Settings names a model for this role.
    ...(model === null ? [] : ['--model', model]),
    '--output-format',
    'json',
    '--add-dir',
    spec.moduleDir,
    '--allowed-tools',
    spec.allowedTools.join(','),
    '--max-turns',
    String(spec.maxTurns),
  ];
}

function minimalEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    USERPROFILE: process.env.USERPROFILE ?? '',
  };
}

type Mutex = { locked: boolean; queue: (() => void)[] };

class SessionMutexRegistry {
  private readonly byKey = new Map<string, Mutex>();

  async acquire(key: string): Promise<() => void> {
    let m = this.byKey.get(key);
    if (!m) {
      m = { locked: false, queue: [] };
      this.byKey.set(key, m);
    }
    if (!m.locked) {
      m.locked = true;
      return () => this.release(key);
    }
    await new Promise<void>((resolve) => m!.queue.push(resolve));
    m.locked = true;
    return () => this.release(key);
  }

  private release(key: string): void {
    const m = this.byKey.get(key);
    if (!m) return;
    const next = m.queue.shift();
    if (next) {
      next();
    } else {
      m.locked = false;
    }
  }
}

/**
 * The one place a provider becomes a wire format.
 *
 * WHY it is a free function and not only a method: the Settings "test connection" button
 * has to reach the very transport a session would use — a test that exercised a second,
 * simpler code path would be a test of the wrong thing. Resolving it per call is also what
 * makes a provider change in Settings take effect on the next session rather than the next
 * restart, and passing the role through is what lets chat and lesson planning be two
 * models on one provider.
 */
export function transportFor(config: AppConfig, role: SessionRole): CliTransport {
  const provider = config.provider;
  if (provider === 'ollama') return new OllamaTransport(ollamaSettingsFor(config, role));
  if (provider === 'llama') return new LlamaTransport(llamaSettingsFor(config, role));
  if (provider === 'anthropic') return new AnthropicTransport(remoteSettingsFor(config, provider, role));
  if (provider === 'gemini') return new GeminiTransport(remoteSettingsFor(config, provider, role));
  if (isRemoteProvider(provider)) return new OpenAiTransport(provider, remoteSettingsFor(config, provider, role));
  return new RealTransport();
}

export class SessionRunner {
  // WHY nullable: the provider is a setting the learner can change while the app is
  // running, but the runner is built once at boot. Resolving the transport per spawn
  // is what makes switching to a local model take effect on the next session rather
  // than on the next restart. An injected transport (tests, fakes) always wins.
  private readonly injected: CliTransport | null;
  private readonly stallMs: number;
  private readonly mutexes = new SessionMutexRegistry();
  private readonly inFlight = new Map<SessionId, CliChildHandle>();
  private readonly retained = new Set<Promise<CliSessionResult>>();
  // WHY it lives here and not on the caller: this is the component that spawns the
  // processes, so it is the only place that can bound ALL of them — a writing fan-out,
  // an evaluation turn and a review question are the same load on the same provider.
  // It is a queue, never a refusal: a session over the limit waits its turn.
  private readonly slots: Semaphore;
  // WHY (H8 / event-loop budget): spawning a child process is heavy and largely synchronous,
  // and a wide pool acquires its permits in one tick — so every session in a fan-out spawned
  // inside a single turn of the loop and the app served nothing for the length of the burst.
  // The heartbeat guard in tests/perf/api-loop.perf.test.ts saw it immediately. The chain
  // puts one spawn per turn of the loop, which costs a swarm nothing it can measure — the
  // sessions themselves run for minutes — and gives every request in between a chance to run.
  private spawnLane: Promise<void> = Promise.resolve();
  // WHY cancellation is tracked separately from `inFlight`: a session waiting for a slot
  // has no child to kill yet, and an abort that arrived while it queued must still stop
  // it rather than let it spawn minutes later.
  private readonly cancelled = new Set<SessionId>();
  private closed = false;

  constructor(opts?: { transport?: CliTransport; stallMs?: number; concurrency?: number }) {
    this.injected = opts?.transport ?? null;
    this.stallMs = opts?.stallMs ?? STALL_MS_DEFAULT;
    this.slots = new Semaphore(opts?.concurrency ?? loadConfig().sessionConcurrency);
  }

  /** WHY the role travels with the provider: lesson planning and chat can be two models
   *  on the same provider, and the transport is where that choice becomes an address and
   *  a model name. Resolving it per spawn also keeps a Settings change taking effect on
   *  the next session rather than the next restart. */
  private transportFor(config: AppConfig, role: SessionRole): CliTransport {
    if (this.injected !== null) return this.injected;
    return transportFor(config, role);
  }

  async run(spec: CliSessionSpec, outputSchema?: z.ZodTypeAny): Promise<CliSessionResult> {
    if (this.closed) {
      return this.failure(spec.id, 'cancelled', 'The session runner is shutting down.', Date.now(), Date.now());
    }

    const task = this.slots.run(async () => {
      if (this.closed || this.cancelled.has(spec.id)) {
        return this.failure(spec.id, 'cancelled', 'That was cancelled.', Date.now(), Date.now());
      }
      return this.execute(spec, outputSchema);
    }, priorityOf(spec.kind));
    this.retained.add(task);
    try {
      return await task;
    } finally {
      this.retained.delete(task);
      this.cancelled.delete(spec.id);
    }
  }

  // Each caller waits for the one before it, then for a turn of the loop of its own.
  private spawnTurn(): Promise<void> {
    const turn = this.spawnLane.then(() => new Promise<void>((resolve) => setImmediate(resolve)));
    // A rejection here would strand every later spawn behind it; nothing in the chain
    // rejects, and this keeps that true whatever a future link does.
    this.spawnLane = turn.catch(() => undefined);
    return turn;
  }

  private async execute(spec: CliSessionSpec, outputSchema?: z.ZodTypeAny): Promise<CliSessionResult> {
    const start = Date.now();
    const dataRoot = loadConfig().dataRoot;
    const topicsDir = paths(dataRoot).topicsDir;

    let confinedModuleDir: string;
    try {
      confinedModuleDir = realpathSync(spec.moduleDir);
    } catch {
      return this.failure(spec.id, 'sandbox-violation', 'The module directory could not be resolved.', start, Date.now());
    }
    if (!isContained(topicsDir, confinedModuleDir)) {
      return this.failure(spec.id, 'sandbox-violation', 'The module directory is outside the sandbox.', start, Date.now());
    }

    const release = await this.mutexes.acquire(confinedModuleDir);
    try {
      await this.spawnTurn();
      return await this.spawnAndWait(spec, confinedModuleDir, outputSchema, start);
    } finally {
      release();
    }
  }

  private spawnAndWait(
    spec: CliSessionSpec,
    cwd: string,
    outputSchema: z.ZodTypeAny | undefined,
    start: number,
  ): Promise<CliSessionResult> {
    const config = loadConfig();
    const bin = config.claudeBin;
    const role = roleOfKind(spec.kind);
    const argv = buildArgv(spec, claudeModelFor(config, role));
    const transport = this.transportFor(config, role);
    const local = runsOnThisMachine(config, role);
    const timeoutMs = local ? Math.max(spec.timeoutMs, LOCAL_MIN_TIMEOUT_MS) : spec.timeoutMs;
    // WHY the stall budget moves with it: an Ollama answer arrives in one write at the
    // very end, so "no output yet" lasts the whole session. A stall budget shorter than
    // the session's own timeout would kill it before its deadline.
    const stallMs = local ? Math.max(this.stallMs, timeoutMs) : this.stallMs;
    const missingMessage = providerMissingMessage(config, role);
    // WHY it is resolved here and not inside the adapter: file-scoped authoring is F6's
    // guarantee, not a provider's feature, so it is applied once for every provider that
    // cannot do it itself. An adapter therefore contains no file handling at all.
    const fileScoped = !hasFileTools(config.provider);
    // WHY a failure to read the directory does not fail the session: the module dir is
    // confined and was resolved above, so this can only be an I/O fault on files the
    // session may not even need. Sending the prompt without them is the smaller loss.
    let prompt = spec.prompt;
    if (fileScoped) {
      try {
        prompt = withWorkspace(spec.prompt, cwd, spec.allowedTools);
      } catch (e) {
        log({ level: 'warn', event: 'workspace-read-failed', component: 'C2', sessionId: spec.id, cause: e instanceof Error ? e.message : String(e) });
      }
    }

    return new Promise<CliSessionResult>((resolve) => {
      let settled = false;
      let stdout = '';
      let bytesSinceTick = 0;
      // WHY: finish() closes over the hard timer before it is set, so it lives in a
      // holder rather than as a binding that would have to be reassigned.
      const timers: { hard?: NodeJS.Timeout } = {};
      let stallTimer: NodeJS.Timeout | undefined;
      let handle: CliChildHandle;

      const finish = (result: CliSessionResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timers.hard);
        clearTimeout(stallTimer);
        this.inFlight.delete(spec.id);
        resolve(result);
      };

      // WHY the SIGKILL timer is not held in a variable finish() can clear: every caller
      // of killTree() settles the session in the same tick, and finish() used to cancel
      // the escalation before it could ever fire. A child that ignores SIGTERM — the
      // wedged case the stall budget exists for — then survived as an orphan holding a
      // provider session, unreachable by cancel() because finish() had already dropped it
      // from `inFlight`, while the module mutex released and let a retry pay for the same
      // work twice. The escalation now outlives the bookkeeping, exactly as cancel() does.
      const killTree = (): void => {
        const child = handle;
        try {
          child.kill('SIGTERM');
        } catch {
          // already gone
        }
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // already gone
          }
        }, KILL_GRACE_MS);
      };

      const armStall = (): void => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          log({ level: 'warn', event: 'cli-session-stall', component: 'C2', correlationId: newCorrelationId(), sessionId: spec.id });
          killTree();
          finish(this.failureShape(spec.id, 'timeout', 'The session stalled with no output.', start, Date.now()));
        }, stallMs);
      };

      try {
        handle = transport.spawn(bin, argv, { cwd, env: minimalEnv() });
      } catch (e) {
        const nodeErr = e as NodeJS.ErrnoException;
        finish(
          this.failureShape(
            spec.id,
            'cli-missing',
            missingMessage,
            start,
            Date.now(),
            nodeErr,
          ),
        );
        return;
      }

      this.inFlight.set(spec.id, handle);

      timers.hard = setTimeout(() => {
        killTree();
        finish(
          this.failureShape(
            spec.id,
            'timeout',
            `The session exceeded its ${timeoutMs}ms timeout.`,
            start,
            Date.now(),
          ),
        );
      }, timeoutMs);

      armStall();

      handle.onError((e: Error) => {
        const nodeErr = e as NodeJS.ErrnoException;
        if (nodeErr.code === 'ENOENT') {
          finish(this.failureShape(spec.id, 'cli-missing', missingMessage, start, Date.now(), nodeErr));
        } else {
          finish(this.failureShape(spec.id, 'nonzero-exit', 'The Claude CLI failed to run.', start, Date.now(), nodeErr));
        }
      });

      handle.onStdout((chunk: Buffer) => {
        bytesSinceTick += chunk.length;
        armStall();
        if (stdout.length < MAX_STDOUT_BYTES) {
          stdout += chunk.toString('utf8');
        }
        log({ level: 'debug', event: 'cli-session-progress', component: 'C2', sessionId: spec.id, bytesSinceLastTick: bytesSinceTick });
        bytesSinceTick = 0;
      });

      handle.onExit((code, signal) => {
        if (settled) return;
        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          finish(this.failureShape(spec.id, 'cancelled', 'The session was cancelled.', start, Date.now()));
          return;
        }
        if (stdout.length > MAX_STDOUT_BYTES) {
          finish(this.failureShape(spec.id, 'nonzero-exit', 'The session output exceeded the size limit.', start, Date.now()));
          return;
        }
        // WHY we read the output before judging the exit code: on a real 14-session run the
        // CLI twice exited non-zero *after* streaming a complete answer — 16KB of finished
        // lesson thrown away unread, and the learner charged a session for it. The exit code
        // alone cannot tell a session that died from one that finished and then stumbled on
        // the way out. So the output is put through exactly the same gate a clean exit faces:
        // it must parse, it must not be an envelope the CLI itself flagged `is_error`, and it
        // must satisfy the output schema. Nothing that fails any of those is accepted, so this
        // can only ever rescue an answer that was already complete and valid — and when it
        // does not, `exitFailure` reports the non-zero exit, not the downstream symptom.
        const exitFailure = (message: string, cause?: unknown): CliSessionResult =>
          this.failureShape(
            spec.id,
            'nonzero-exit',
            code === 0 ? message : `The Claude CLI exited with code ${String(code)}.`,
            start,
            Date.now(),
            cause,
            stdout,
          );
        let parsed: unknown;
        try {
          parsed = JSON.parse(stdout);
        } catch (e) {
          finish(exitFailure('The session output could not be parsed.', e));
          return;
        }
        const unwrapped = unwrapCliOutput(parsed);
        if (!unwrapped.ok) {
          finish(exitFailure(`The session output could not be read — ${unwrapped.reason}.`));
          return;
        }
        parsed = unwrapped.output;
        // WHY the files come out before the schema check and not after: `files` is an
        // extra key this app added to the answer, and every output contract is strict
        // about the keys it allows. Leaving it in place would make the lesson a provider
        // wrote with a file alongside it fail validation for having obeyed us.
        let filesWritten: string[] = [];
        if (fileScoped) {
          try {
            const taken = takeWorkspaceWrites(parsed, cwd, spec.allowedTools);
            parsed = taken.output;
            filesWritten = taken.filesWritten;
          } catch (e) {
            log({ level: 'warn', event: 'workspace-write-failed', component: 'C2', sessionId: spec.id, cause: e instanceof Error ? e.message : String(e) });
          }
        }
        if (outputSchema) {
          const parsedResult = outputSchema.safeParse(parsed);
          if (!parsedResult.success) {
            const looksExhausted = stdout.length === 0 || /context.{0,20}(exhaust|limit|too long)/i.test(stdout);
            if (code === 0 && looksExhausted) {
              finish(
                this.failureShape(
                  spec.id,
                  'context-exhausted',
                  'The session output did not match the expected shape.',
                  start,
                  Date.now(),
                  parsedResult.error,
                  stdout,
                ),
              );
              return;
            }
            finish(exitFailure('The session output did not match the expected shape.', parsedResult.error));
            return;
          }
        }
        finish({
          ok: true,
          id: spec.id,
          output: parsed,
          durationMs: Date.now() - start,
          filesWritten,
        });
      });

      handle.write(prompt);
      handle.endStdin();
    });
  }

  private failureShape(
    id: SessionId,
    code: FailureCode,
    message: string,
    start: number,
    end: number,
    cause?: unknown,
    stdout?: string,
  ): CliSessionResult {
    const correlationId = newCorrelationId();
    log({
      level: 'error',
      event: 'cli-session-failed',
      component: 'C2',
      correlationId,
      sessionId: id,
      code,
      cause: cause instanceof Error ? cause.message : (cause ?? null),
      stdoutBytes: stdout?.length ?? 0,
      // WHY: every distinct way a session can fail logs the same `nonzero-exit` code,
      // so without the message and a slice of what the CLI actually said, a failing
      // run is indistinguishable from a schema mismatch or a refusal. Diagnosing one
      // otherwise means re-running a billable session with a patched build.
      detail: message,
      // WHY it is not enough to log the ZodError as `cause`: `cause` is model-adjacent
      // text and is scrubbed, so a contract mismatch reached the log as one opaque hash —
      // "the output did not match the expected shape", with no way to learn WHICH field.
      // A real one (a missing `verdict.remedialNeeded`) cost a learner the same turn
      // repeatedly and could only be identified by re-deriving the hash. Field paths and
      // zod issue codes carry no model text, which is why `contractIssues` is exempt.
      ...(cause instanceof z.ZodError ? { contractIssues: contractIssuesOf(cause) } : {}),
      stdoutExcerpt: stdout === undefined ? null : stdout.slice(0, 800),
    });
    return {
      ok: false,
      id,
      code,
      message,
      correlationId,
      durationMs: end - start,
    };
  }

  private failure(
    id: SessionId,
    code: FailureCode,
    message: string,
    start: number,
    end: number,
  ): CliSessionResult {
    return this.failureShape(id, code, message, start, end);
  }

  cancel(id: SessionId): void {
    const handle = this.inFlight.get(id);
    if (!handle) {
      this.cancelled.add(id);
      return;
    }
    handle.kill('SIGTERM');
    // WHY `unref`: this escalation only matters while the process is still alive.
    // Left referenced it holds the event loop open for the full grace period, so
    // every cancel added five seconds to an otherwise finished exit.
    const escalate = setTimeout(() => {
      try {
        handle.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, KILL_GRACE_MS);
    escalate.unref();
  }

  cancelAll(): void {
    for (const id of Array.from(this.inFlight.keys())) {
      this.cancel(id);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelAll();
    await Promise.allSettled(Array.from(this.retained));
    this.inFlight.clear();
    this.cancelled.clear();
  }
}
