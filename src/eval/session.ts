// FRACTAL: implements F4, F9, F13 | component C6
import { createHash } from 'node:crypto';
import {
  sessionIdSchema,
  type EvalScript,
  type EvalSession,
  type EvalTurn,
  type ModuleGraph,
  type ModuleId,
  type ModuleNode,
  type SessionId,
  type Topic,
  type TopicId,
} from '@/shapes';
import { err } from '@/core/errors';
import { log } from '@/core/log';
import { nowIso } from '@/orchestrator/ids';
import type { Store } from '@/store/open';
import {
  artifactIsReviewable,
  capstoneNode,
  capstoneRounds,
  capstoneRecord,
  topicIsDone,
} from '@/eval/capstone';
import {
  encodeTargetTag,
  synthesisModuleId,
  synthesisOpeningQuestion,
  synthesisScript,
  targetOfSession,
} from '@/eval/synthesis';
import { evalTargetSchema, type EvalTarget, type EvalTurnResult, type LearnerMessage } from '@/eval/shapes';
import { evaluatorTurnId, hydrateSession } from '@/eval/turn-id';
import { respondTo, runTurn, type EvalDeps, type TurnContext } from '@/eval/turn';

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export type EvalKind = EvalSession['kind'];

// WHY: one target means one session row, deterministically. Reopening a module
// after walking away lands on the same id, which is what makes "the chat
// resumes exactly where it stopped" true without a lookup index C1 does not have.
export function sessionIdFor(kind: EvalKind, target: EvalTarget): SessionId {
  const digest = createHash('sha256').update(`${kind}|${encodeTargetTag(target)}`).digest();
  let out = '';
  for (let i = 0; i < 16; i += 1) out += ID_ALPHABET[digest[i] % ID_ALPHABET.length];
  return sessionIdSchema.parse(`s_${out}`);
}

export function moduleIdOfTarget(target: EvalTarget, store: Store): ModuleId {
  if (target.kind === 'synthesis') return synthesisModuleId(target.topicA, target.topicB);
  if (target.kind === 'capstone') {
    const node = capstoneNode(store.modules.graph(target.topicId));
    if (node === null) {
      throw err('not-found', {
        detail: 'capstone requested for a topic with no capstone node',
        userMessage: 'This subject does not have a project yet.',
      });
    }
    return node.id;
  }
  return target.moduleId;
}

export function defaultScript(title: string): EvalScript {
  return {
    objectives: [`Show you can use the ideas in "${title}", not just recite them`],
    seedQuestions: [`Walk me through a situation where "${title}" decides the answer.`],
    angles: ['a worked example', 'a case where it fails', 'explain it to someone else'],
    misconceptions: [],
    passCriteria: [`Fully specifies a solution that uses the ideas in "${title}"`],
  };
}

// WHY (F4): seedQuestions[0] is sent to the learner word for word as the opening
// message, but authoring sessions sometimes write a seed as a stage direction to a
// tutor — "Hand the learner a fresh equation, e.g. ... Ask: which symbols are free?"
// — and there is no tutor between the script and the chat window. Shipped verbatim it
// tells the learner they are being handled, and the "e.g." implies the equation in
// front of them is one arbitrary option. These markers are the third-person ones only;
// a bare imperative ("Give an example of...") is a perfectly good question to a person.
const STAGE_MARKERS: RegExp[] = [/\bthe learner\b/i, /\bask\s+(?:them|him|her)\b/i, /^\s*ask\b[^?]*:/i];

const ASK_SPLIT =
  /(?:^|[.;\n])\s*ask(?:\s+(?:them|him|her|the learner))?(?:\s*[:,]\s*|\s+(?=to\b|whether\b|if\b|what\b|which\b|how\b|why\b|when\b|where\b))/i;

export function isStageDirection(seed: string): boolean {
  return STAGE_MARKERS.some((marker) => marker.test(seed));
}

// WHY it rewrites rather than discards: the setup is usually the only place the
// equation the question is about exists, so dropping the seed drops the question's
// subject with it. The salvage keeps the material and re-addresses the frame.
export function deStage(seed: string): string {
  const parts = seed.split(ASK_SPLIT);
  const asked = parts.length > 1 ? parts[parts.length - 1].trim() : '';
  const setup = (parts.length > 1 ? parts.slice(0, -1).join(' ') : seed)
    .replace(/^\s*(?:hand|give|show|present|offer)\s+(?:the learner|them)\s+/i, 'Here is ')
    .replace(/\bthe learner\b/gi, 'you')
    .replace(/,?\s*e\.g\.\s*/i, ': ')
    .trim();
  // "Ask them to X" is an instruction about a person; "X" is the same request made to
  // them. "Ask them whether X" has no such bare form, so it keeps a stem that does.
  const direct = /^(?:whether|if)\b/i.test(asked) ? `Tell me ${asked}` : asked.replace(/^to\s+/i, '');
  const question = direct === '' ? '' : `${direct.charAt(0).toUpperCase()}${direct.slice(1)}`;
  return [setup, question].filter((part) => part !== '').join('\n\n');
}

// WHY the first seed is rewritten rather than skipped: the seeds are ordered, and the
// first is the one authoring chose to open on — it usually carries the equation the
// whole lesson is about. A later sibling would be a different, narrower question. So
// the ladder is: use the first seed as written, else re-address it, else the first
// sibling that already speaks to the learner, else the generic opener.
export function openingSeed(script: EvalScript, fallback: EvalScript): string {
  const usable = script.seedQuestions.filter((seed) => seed.trim().length > 0);
  if (usable.length === 0) return fallback.seedQuestions[0];
  if (!isStageDirection(usable[0])) return usable[0];
  // WHY the rewrite is re-checked: a direction with no question in it to lift ("Ask
  // them.") survives the rewrite unchanged, and shipping that is worse than the
  // generic opener.
  const salvaged = deStage(usable[0]);
  if (salvaged !== '' && !isStageDirection(salvaged)) return salvaged;
  return usable.find((seed) => !isStageDirection(seed)) ?? fallback.seedQuestions[0];
}

export const ABANDON_NOTE =
  'You stepped away from this conversation. It is saved — pick it up whenever you like.';

// WHY it is worded as a closure and not as a loss: the learner never typed a word here,
// so there is nothing to come back for, and offering to resume an empty conversation
// beside the one they are actually in is the confusion this closes.
export const SUPERSEDED_NOTE =
  'You picked this lesson up in another conversation, so this one was closed. Nothing was lost.';

export type ModuleLocation = { topic: Topic; graph: ModuleGraph; node: ModuleNode };

export function locateModule(store: Store, moduleId: ModuleId): ModuleLocation {
  for (const row of store.topics.list()) {
    if ('degraded' in row) continue;
    const graph = store.modules.graph(row.id);
    const node = graph.nodes.find((n) => n.id === moduleId);
    if (node !== undefined) return { topic: row, graph, node };
  }
  throw err('not-found', {
    detail: 'eval target module belongs to no topic',
    userMessage: 'We could not find that lesson.',
  });
}

export function requireTopic(store: Store, topicId: TopicId): Topic {
  const row = store.topics.get(topicId);
  if (row === null || 'degraded' in row) {
    throw err('not-found', {
      detail: 'eval target topic missing or degraded',
      userMessage: 'We could not find that subject.',
    });
  }
  return row;
}

// WHY (concurrency): two sends on one conversation may not interleave turns, so
// each session id gets a serial queue. The tail is always a settled-swallowing
// promise, and it is dropped once nothing is waiting on it, so the map stays
// bounded by the number of live conversations rather than by turns taken.
export class SessionMutex {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly waiting = new Map<string, number>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    this.waiting.set(key, (this.waiting.get(key) ?? 0) + 1);
    const next = previous.then(work, work);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, settled);
    void settled.then(() => {
      const remaining = (this.waiting.get(key) ?? 1) - 1;
      if (remaining <= 0) {
        this.waiting.delete(key);
        if (this.tails.get(key) === settled) this.tails.delete(key);
      } else {
        this.waiting.set(key, remaining);
      }
    });
    return next;
  }

  pending(key: string): number {
    return this.waiting.get(key) ?? 0;
  }

  size(): number {
    return this.tails.size;
  }
}

// WHY (F4 invariant): while a conversation is open, an evaluator reply is owed for every
// learner message in it. `runTurn` writes the learner's turn before it calls the model, so
// any interruption after that line — a restart, a closed tab, a dropped connection — leaves
// the transcript ending on the learner with no reply and no work running. That state is not
// a resting place: it is the conversation stopped mid-turn. This names it, and everything
// that reads a session can then either finish it or refuse to start a second one on top.
export function unansweredMessage(session: EvalSession): LearnerMessage | null {
  if (session.status !== 'open') return null;
  const last = session.turns[session.turns.length - 1];
  if (last === undefined || last.role !== 'learner') return null;
  return { text: last.text, selfAssessment: last.selfAssessment };
}

export class EvalEngine {
  private readonly mutex = new SessionMutex();
  private readonly inFlight = new Map<SessionId, AbortController>();
  private readonly retained = new Set<Promise<unknown>>();
  private closed = false;

  constructor(private readonly deps: EvalDeps) {}

  private get store(): Store {
    return this.deps.store;
  }

  open(kind: EvalKind, target: EvalTarget): EvalSession {
    const parsedTarget = evalTargetSchema.parse(target);
    const id = sessionIdFor(kind, parsedTarget);
    const existing = this.store.evals.get(id);
    if (existing !== null) {
      const live = hydrateSession(existing);
      // WHY: closing an untouched sibling must not make that gate unreachable. The id is
      // derived from the target, so reopening lands on the same row, and a row closed
      // with nothing in it has nothing to preserve — reviving it is what makes "closed
      // because you went elsewhere" a note rather than a dead end. A conversation the
      // learner actually spoke in is never revived this way; restart is for that.
      if (live.status === 'abandoned' && !live.turns.some((turn) => turn.role === 'learner')) {
        const opening = this.openingTurn(parsedTarget);
        const openedAt = nowIso();
        this.store.evals.reset(id, opening, openedAt);
        log({ level: 'info', event: 'eval-session-revived', component: 'C6', sessionId: id, kind });
        return hydrateSession({ ...live, turns: [opening], consecutiveFailures: 0, status: 'open', openedAt });
      }
      return live;
    }

    const moduleId = moduleIdOfTarget(parsedTarget, this.store);
    const opening = this.openingTurn(parsedTarget);
    const session: EvalSession = {
      id,
      moduleId,
      kind,
      turns: [opening],
      consecutiveFailures: 0,
      status: 'open',
      openedAt: nowIso(),
    };
    this.store.evals.create(session);
    log({ level: 'info', event: 'eval-session-opened', component: 'C6', sessionId: id, kind });
    return hydrateSession(session);
  }

  // WHY (F4): resuming is a pure read of the transcript that already exists — no model
  // runs. `open` cannot serve that: it creates the session when there is none, and the
  // page has to know the difference so it only opens the conversation it means to.
  peek(kind: EvalKind, target: EvalTarget): EvalSession | null {
    const existing = this.store.evals.get(sessionIdFor(kind, evalTargetSchema.parse(target)));
    return existing === null ? null : hydrateSession(existing);
  }

  // WHY: the only way a conversation is ever discarded. Everything else resumes it, so
  // starting over has to be something the learner asks for by name.
  restart(sessionId: SessionId): EvalSession {
    const session = this.resume(sessionId);
    const target = targetOfSession(session);
    if (target === null) {
      throw err('not-found', {
        detail: 'restart for a session with no decodable target tag',
        userMessage: 'We could not work out what this conversation is about.',
      });
    }
    this.cancel(sessionId);
    const opening = this.openingTurn(target);
    const openedAt = nowIso();
    this.store.evals.reset(sessionId, opening, openedAt);
    log({ level: 'info', event: 'eval-session-restarted', component: 'C6', sessionId });
    return hydrateSession({ ...session, turns: [opening], consecutiveFailures: 0, status: 'open', openedAt });
  }

  // WHY: the opening turn carries the target tag in its angle slot. It is the
  // only durable place a synthesis session's second topic can live, because
  // C1's eval_sessions row holds exactly one module id.
  private openingTurn(target: EvalTarget): EvalTurn {
    const text =
      target.kind === 'synthesis'
        ? synthesisOpeningQuestion(
            requireTopic(this.store, target.topicA),
            requireTopic(this.store, target.topicB),
          )
        : this.openingQuestionFor(target);
    return {
      id: 'v0:continue',
      role: 'evaluator',
      text,
      assistLevel: 0,
      angle: encodeTargetTag(target),
      mode: 'question',
      selfAssessment: null,
      at: nowIso(),
    };
  }

  private openingQuestionFor(target: Exclude<EvalTarget, { kind: 'synthesis' }>): string {
    if (target.kind === 'capstone') {
      const record = capstoneRecord(requireTopic(this.store, target.topicId), this.store.modules.graph(target.topicId), null);
      return record === null
        ? 'Tell me what you built.'
        : `Here is your project brief:\n\n${record.spec}\n\nWhen you are ready, paste or describe what you built and why you made each choice.`;
    }
    const { node } = locateModule(this.store, target.moduleId);
    const script = node.content?.evalScript ?? defaultScript(node.title);
    return openingSeed(script, defaultScript(node.title));
  }

  resume(sessionId: SessionId): EvalSession {
    const session = this.store.evals.get(sessionId);
    if (session === null) {
      throw err('not-found', {
        detail: 'resume for an unknown eval session',
        userMessage: 'We could not find that conversation.',
      });
    }
    return hydrateSession(session);
  }

  // WHY it happens on send and not on open: opening a `test-out` beside a `module`
  // session is how the learner chooses which gate to sit, and at open time neither has
  // been spoken in — closing either would be a guess. The first message settles it. Only
  // a sibling still at its opening question is closed, so nothing the learner wrote is
  // ever discarded; a conversation with real turns in it stays for them to come back to.
  private closeUntouchedSiblings(session: EvalSession): void {
    for (const sibling of this.store.evals.listByModule(session.moduleId)) {
      if (sibling.id === session.id) continue;
      const other = hydrateSession(sibling);
      if (other.status !== 'open') continue;
      if (other.turns.some((turn) => turn.role === 'learner')) continue;
      this.abandon(other.id, SUPERSEDED_NOTE);
      log({
        level: 'info',
        event: 'eval-session-superseded',
        component: 'C6',
        sessionId: other.id,
        kind: other.kind,
      });
    }
  }

  abandon(sessionId: SessionId, note: string = ABANDON_NOTE): void {
    const session = this.resume(sessionId);
    if (session.status === 'abandoned') return;
    this.cancel(sessionId);
    this.store.evals.append(sessionId, {
      id: evaluatorTurnId(session.turns.length, 'abandoned'),
      role: 'evaluator',
      text: note,
      assistLevel: null,
      angle: null,
      mode: 'explanation',
      selfAssessment: null,
      at: nowIso(),
    });
    log({ level: 'info', event: 'eval-session-abandoned', component: 'C6', sessionId });
  }

  contextFor(session: EvalSession): TurnContext {
    const target = targetOfSession(session);
    if (target === null) {
      throw err('not-found', {
        detail: 'eval session has no decodable target tag',
        userMessage: 'We could not work out what this conversation is about.',
      });
    }
    if (target.kind === 'synthesis') {
      const topic = requireTopic(this.store, target.topicA);
      const topicB = requireTopic(this.store, target.topicB);
      return {
        session,
        target,
        topic,
        topicB,
        graph: this.store.modules.graph(target.topicA),
        node: null,
        script: synthesisScript(topic, topicB),
      };
    }
    if (target.kind === 'capstone') {
      const topic = requireTopic(this.store, target.topicId);
      const graph = this.store.modules.graph(target.topicId);
      const node = capstoneNode(graph);
      if (node === null) {
        throw err('not-found', {
          detail: 'capstone session for a topic with no capstone node',
          userMessage: 'This subject does not have a project yet.',
        });
      }
      return {
        session,
        target,
        topic,
        topicB: null,
        graph,
        node,
        script: node.content?.evalScript ?? defaultScript(node.title),
      };
    }
    const { topic, graph, node } = locateModule(this.store, target.moduleId);
    return {
      session,
      target,
      topic,
      topicB: null,
      graph,
      node,
      script: node.content?.evalScript ?? defaultScript(node.title),
    };
  }

  send(sessionId: SessionId, message: LearnerMessage): Promise<EvalTurnResult> {
    return this.guard(sessionId, (signal) => {
      const session = this.resume(sessionId);
      if (session.status === 'abandoned') {
        throw err('conflict', {
          detail: 'send to an abandoned eval session',
          userMessage: 'That conversation was closed. Open the lesson again to start a new one.',
        });
      }
      this.closeUntouchedSiblings(session);
      // WHY: Retry after a failed turn resends the same text, but the failed turn had
      // already been written — appending it again gave the transcript the learner's
      // words twice and asked the model to answer a question it could see it had just
      // been asked. The saved turn is the same turn; this finishes it rather than
      // repeating it.
      const pending = unansweredMessage(session);
      if (pending !== null && pending.text === message.text) {
        return respondTo(this.deps, this.contextFor(session), pending, signal);
      }
      return runTurn(this.deps, this.contextFor(session), message, signal);
    });
  }

  // WHY it exists (F4): reopening a conversation that stopped mid-turn has to restart the
  // work, not just redraw the transcript. Nothing else can — the learner has already said
  // their piece, so there is no message for them to send, and the request that owed them a
  // reply is gone. This resumes the owed reply from the durable turn, and answers `null`
  // when nothing is owed so the caller does not have to know the rule.
  //
  // WHY it takes the mutex like a send: a resume racing a send on the same conversation is
  // exactly the interleaving `SessionMutex` exists to prevent, and this is now a second way
  // in. Whichever runs second re-reads the session and finds the reply already there.
  continueTurn(sessionId: SessionId): Promise<EvalTurnResult | null> {
    return this.guard(sessionId, (signal) => {
      const session = this.resume(sessionId);
      const pending = unansweredMessage(session);
      if (pending === null) return Promise.resolve(null);
      log({ level: 'info', event: 'eval-turn-resumed', component: 'C6', sessionId });
      return respondTo(this.deps, this.contextFor(session), pending, signal);
    });
  }

  // WHY (F13): revise-and-resubmit is the same turn pipeline — the artefact is
  // the learner's message — so prior rounds stay in the transcript and stay
  // visible instead of being replaced by the latest one.
  submitCapstone(topicId: TopicId, artifact: string): Promise<EvalTurnResult> {
    if (!artifactIsReviewable(artifact)) {
      return Promise.reject(
        err('validation', {
          detail: 'capstone artifact too short or too large to review',
          userMessage: 'Tell us a bit more about what you built — a sentence or two at least.',
        }),
      );
    }
    const target = evalTargetSchema.parse({ kind: 'capstone', topicId });
    const session = this.open('capstone', target);
    return this.send(session.id, { text: artifact, selfAssessment: null });
  }

  rounds(topicId: TopicId): ReturnType<typeof capstoneRounds> {
    const id = sessionIdFor('capstone', evalTargetSchema.parse({ kind: 'capstone', topicId }));
    const session = this.store.evals.get(id);
    return session === null ? [] : capstoneRounds(session);
  }

  // WHY (H10): this rule — a subject is only finished once the capstone itself passes —
  // used to exist twice, here and in @/eval/capstone, in two hand-copied forms. One of them
  // would eventually have been changed alone. It lives in capstone.ts, next to the AC it
  // implements, and this method now asks it.
  topicIsDone(topicId: TopicId): boolean {
    return topicIsDone(this.store.modules.graph(topicId));
  }

  cancel(sessionId: SessionId): void {
    this.inFlight.get(sessionId)?.abort();
  }

  activeSessions(): number {
    return this.inFlight.size;
  }

  // WHY (long-running work): the controller is registered before the work
  // starts and removed in a finally, so the in-flight flag clears on every exit
  // path — success, failure, or cancellation — and the mutex is released with it.
  private guard<T>(sessionId: SessionId, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        err('cancelled', { detail: 'send after engine teardown', userMessage: 'That was cancelled.' }),
      );
    }
    const task = this.mutex.run<T>(sessionId, async () => {
      const controller = new AbortController();
      this.inFlight.set(sessionId, controller);
      try {
        return await work(controller.signal);
      } finally {
        this.inFlight.delete(sessionId);
      }
    });
    this.retained.add(task);
    void task.catch(() => undefined).then(() => this.retained.delete(task));
    return task;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.inFlight.values()) controller.abort();
    await Promise.allSettled(Array.from(this.retained));
    this.inFlight.clear();
    this.retained.clear();
  }
}

export function createEvalEngine(deps: EvalDeps): EvalEngine {
  return new EvalEngine(deps);
}
