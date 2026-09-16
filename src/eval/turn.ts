// FRACTAL: implements F4, F9, F13 | component C6
import {
  type EvalScript,
  type EvalSession,
  type EvalTurn,
  type EvalVerdict,
  type ModuleGraph,
  type ModuleNode,
  type Topic,
} from '@/shapes';
import { err, newCorrelationId } from '@/core/errors';
import { log } from '@/core/log';
import { nowIso } from '@/orchestrator/ids';
import { dispatchSession, type OrchestratorDeps } from '@/orchestrator/session';
import { buildChatTurn, type ModuleBrief } from '@/cli/prompt';
import { evalTurnResultSchema, type EvalTarget, type EvalTurnResult, type LearnerMessage } from '@/eval/shapes';
import { computeCalibration, toCalibrationView, type CalibrationView } from '@/reflect/calibration';
import {
  enforcePassCriteria,
  evaluatorOutputSchema,
  grantsCompletion,
  parseEvaluatorOutput,
  toEvalVerdict,
  validateLearnerMessage,
  type EvaluatorOutput,
} from '@/eval/verdict-parse';
import { angleLedger, checkReask, chooseAngle, currentAngle, isNearDuplicate, priorQuestions } from '@/eval/angles';
import {
  applyHintLadder,
  currentAssistLevel,
  withExplanation,
  ASSISTED_PASS_THRESHOLD,
  CAPSTONE_ASSISTED_PASS_THRESHOLD,
} from '@/eval/hints';
import { angleForMisconception, gateTeachBackVerdict, selectMisconception, teachBackPrompt } from '@/eval/teach-back';
import { conceptFor, requestRemedial, shouldRequestRemedial, type RemedialRequester } from '@/eval/remedial';
import { affectsCompletion } from '@/eval/synthesis';
import { prepareAvailable, type PrepRequester } from '@/orchestrator/prepare-available';
import { readTopicState } from '@/orchestrator/topic-state';
import { scopeInstructions, taughtScope } from '@/eval/scope';
import { capstoneRounds, priorFeedbackDigest } from '@/eval/capstone';
import { consecutiveFailuresOf, evaluatorOutcomes, evaluatorTurnId, hydrateSession, learnerTurnId } from '@/eval/turn-id';
import { recordGradedReview } from '@/review/schedule';

export const EVAL_TIMEOUT_MS = 120 * 1000;
export const CAPSTONE_REVIEW_TIMEOUT_MS = 180 * 1000;
export const MAX_TRANSCRIPT_TURNS = 40;

export const EVALUATOR_SILENT_MESSAGE =
  'The evaluator did not respond. Your message is saved — press Retry to send it again.';

export type EvalDeps = OrchestratorDeps & { orchestrator: RemedialRequester & PrepRequester };

export type TurnContext = {
  session: EvalSession;
  target: EvalTarget;
  topic: Topic;
  topicB: Topic | null;
  graph: ModuleGraph;
  node: ModuleNode | null;
  script: EvalScript;
};

function transcriptLines(session: EvalSession): string[] {
  return session.turns
    .slice(-MAX_TRANSCRIPT_TURNS)
    .map((t) => `${t.role === 'learner' ? 'Learner' : 'Evaluator'}: ${t.text}`);
}

// WHY (sink): every piece of learner text reaches the model through a list item
// that C2's buildPrompt fences as data. Nothing the learner typed is ever
// concatenated into an instruction line.
export function briefFor(ctx: TurnContext, message: LearnerMessage): ModuleBrief {
  // WHY the scope comes from the node and not the script: the eval script is what the
  // authoring session INTENDED to test, written before the lesson body was; the blocks are
  // what the learner was actually shown. Where the two disagree the lesson wins, because
  // that is the material on the page they just read.
  // WHY capstone and synthesis are excluded: both are deliberately whole-course work —
  // the capstone is judged against everything the subject taught, and synthesis spans two
  // subjects — so bounding either to one node's lesson would narrow the gate rather than
  // aim it. This is for the two gates that ARE about a single lesson.
  const scope =
    ctx.target.kind === 'module' || ctx.target.kind === 'review' ? taughtScope(ctx.node) : [];
  const instructions = [
    'Judge understanding, not recall. Require a fully specified solution.',
    ...scopeInstructions(scope),
    ...ctx.script.objectives.map((o) => `Objective: ${o}`),
    ...ctx.script.passCriteria.map((c) => `Pass criterion: ${c}`),
    ...(ctx.target.kind === 'capstone' ? priorFeedbackDigest(capstoneRounds(ctx.session)) : []),
  ];
  const rating = selfAssessmentLine(message);
  const selfAssessment = rating === null ? [] : [`Learner self-rating ${rating}`];
  return {
    topicSubject: ctx.topicB === null ? ctx.topic.subject : `${ctx.topic.subject} + ${ctx.topicB.subject}`,
    level: ctx.topic.level,
    levelDetail: ctx.topic.levelDetail ?? null,
    purpose: ctx.topic.purpose,
    drivingQuestion: ctx.topic.drivingQuestion ?? '',
    moduleTitle: ctx.node?.title ?? `${ctx.topic.subject} conversation`,
    moduleObjectives: instructions,
    prerequisiteSummaries: [],
    downstreamSummaries: [],
    taughtContent: scope.length === 0 ? undefined : scope,
    priorKnowledge: [...transcriptLines(ctx.session), ...selfAssessment, `Learner: ${message.text}`],
    targetMinutes: ctx.node?.estimatedMinutes ?? 20,
  };
}

// WHY it is shared: the self-rating reaches the model the same way on the opening turn
// and on a resumed one, and two hand-copied wordings would drift into two different
// things for the model to interpret.
export function selfAssessmentLine(message: LearnerMessage): string | null {
  return message.selfAssessment === null
    ? null
    : `${message.selfAssessment.confidence} of 5: ${message.selfAssessment.critique}`;
}

// WHY only capstone has any: everything else a turn needs is either in the conversation
// the CLI is holding or unchanged since it opened. Prior-round feedback is neither — the
// app derives it from rounds the learner may have taken days apart.
function turnReminders(ctx: TurnContext): string[] {
  return ctx.target.kind === 'capstone' ? priorFeedbackDigest(capstoneRounds(ctx.session)) : [];
}

function appendTurn(deps: EvalDeps, session: EvalSession, turn: EvalTurn): EvalSession {
  deps.store.evals.append(session.id, turn);
  return { ...session, turns: [...session.turns, turn] };
}

export function learnerTurn(session: EvalSession, message: LearnerMessage): EvalTurn {
  return {
    id: learnerTurnId(session.turns.length),
    role: 'learner',
    text: message.text,
    assistLevel: null,
    angle: null,
    mode: 'question',
    selfAssessment: message.selfAssessment,
    at: nowIso(),
  };
}

type Composed = { text: string; mode: EvalTurn['mode']; angle: string | null; verdict: EvalVerdict };

export const EXHAUSTED_NOTE =
  'We have come at this from every angle here. Let us take a short practice lesson on it and then try again.';

// WHY (F4 AC): a re-ask must be a genuinely different question. The angle must
// be unused AND the text must not be a near-duplicate of anything already
// asked; when neither can be satisfied the exchange switches to teach-back, and
// when that is exhausted too it asks for a remedial lesson instead of repeating.
export function compose(
  ctx: TurnContext,
  output: EvaluatorOutput,
  verdict: EvalVerdict,
  mode: EvalTurn['mode'],
): Composed {
  if (mode !== 'question' && mode !== 'hint') {
    return { text: withExplanation(output.reply, verdict), mode, angle: output.angle, verdict };
  }
  const asked = priorQuestions(ctx.session.turns);
  const fresh = !isNearDuplicate(output.reply, asked);
  // WHY a hint is not held to the angle ledger: it is scaffolding on the question the
  // learner is already working on, not a new way in. Charging it an angle spent the
  // ladder three times faster than the ladder climbs, and the exchange hit
  // "no angles left" while the learner was still on the first question.
  if (mode === 'hint') {
    if (fresh) {
      return {
        text: withExplanation(output.reply, verdict),
        mode,
        angle: currentAngle(ctx.session.turns),
        verdict,
      };
    }
  } else {
    const ledger = angleLedger(ctx.script, ctx.session.turns);
    const angle = chooseAngle(ledger, output.angle ?? verdict.nextAngle);
    const check = checkReask(output.reply, angle, ledger, asked);
    if (check.ok) {
      return { text: withExplanation(output.reply, verdict), mode, angle: check.angle, verdict };
    }
    // WHY an empty ledger alone does not stop the conversation: the ledger names the
    // angles authoring thought of, and running out of names is not the same as running
    // out of questions. A reply that repeats nothing already asked is a real new
    // question, so it goes through unlabelled. Only an actual repeat falls through.
    if (check.reason === 'no-angles-left' && fresh) {
      return { text: withExplanation(output.reply, verdict), mode, angle: null, verdict };
    }
  }
  const misconception = selectMisconception(ctx.script, ctx.session.turns);
  if (misconception !== null) {
    return {
      text: withExplanation(teachBackPrompt(misconception), verdict),
      mode: 'teach-back',
      angle: angleForMisconception(misconception),
      verdict,
    };
  }
  // WHY it is said once: this line hands the exchange to a remedial lesson, and that
  // handoff only happens the first time. Sent again on every later turn it became the
  // whole conversation — the learner typed, and got the same sentence back forever, with
  // a fresh remedial request queued behind each one. After it has been said, the
  // evaluator's own reply is what the learner gets, repetitive or not: a similar
  // question still moves, an identical dead end does not.
  if (!ctx.session.turns.some((turn) => turn.role === 'evaluator' && turn.text.includes(EXHAUSTED_NOTE))) {
    return {
      text: withExplanation(EXHAUSTED_NOTE, verdict),
      mode: 'explanation',
      angle: null,
      verdict: { ...verdict, remedialNeeded: true },
    };
  }
  return { text: withExplanation(output.reply, verdict), mode, angle: null, verdict };
}

function lastEvaluatorTurn(session: EvalSession): EvalTurn | null {
  for (let i = session.turns.length - 1; i >= 0; i -= 1) {
    if (session.turns[i].role === 'evaluator') return session.turns[i];
  }
  return null;
}

function applyTeachBackGate(ctx: TurnContext, verdict: EvalVerdict, answer: string): EvalVerdict {
  const previous = lastEvaluatorTurn(ctx.session);
  if (previous === null || previous.mode !== 'teach-back' || previous.angle === null) return verdict;
  const id = previous.angle.split(':')[1] ?? '';
  const misconception = ctx.script.misconceptions.find((m) => m.id === id);
  if (misconception === undefined) return verdict;
  return gateTeachBackVerdict(verdict, answer, misconception).verdict;
}

// WHY (state lifecycle): the learner's turn is appended BEFORE the model call,
// so an interruption anywhere after this line loses the reply but never the
// text the learner typed — Retry resends it without retyping.
export async function runTurn(
  deps: EvalDeps,
  ctx: TurnContext,
  rawMessage: unknown,
  signal: AbortSignal,
): Promise<EvalTurnResult> {
  const message = validateLearnerMessage(rawMessage);
  const active: TurnContext = { ...ctx, session: appendTurn(deps, ctx.session, learnerTurn(ctx.session, message)) };
  return respondTo(deps, active, message, signal);
}

// WHY it is separate from `runTurn`: the learner's turn is durable the moment it is
// appended, but the reply that answers it only exists inside the request that was
// running when the model was called. A process restart, a closed tab or a dropped
// connection therefore leaves a saved question with no answer and nothing in flight —
// the conversation stops with the learner holding the floor. This is the half of the
// pipeline that can be run again over a turn that is ALREADY in the transcript, so a
// dangling message can be answered instead of re-asked. `ctx.session` must already end
// with the learner turn `message` came from.
export async function respondTo(
  deps: EvalDeps,
  active: TurnContext,
  message: LearnerMessage,
  signal: AbortSignal,
): Promise<EvalTurnResult> {
  const outcome = await dispatchSession(deps, {
    kind: 'evaluate',
    topicId: active.topic.id,
    workspaceModuleId: active.node?.id ?? active.session.moduleId,
    ephemeralWorkspace: active.node === null,
    brief: briefFor(active, message),
    // WHY the session id is the key: it is already the one durable name for this
    // conversation (sessionIdFor), so a learner who walks away and comes back lands on the
    // same CLI conversation rather than paying the opening cost again.
    conversation: { key: active.session.id, turnPrompt: buildChatTurn(message.text, selfAssessmentLine(message), turnReminders(active)).prompt,
    },
    outputSchema: evaluatorOutputSchema,
    timeoutMs: active.target.kind === 'capstone' ? CAPSTONE_REVIEW_TIMEOUT_MS : EVAL_TIMEOUT_MS,
    maxTurns: 8,
    allowedTools: [],
    signal,
  });

  if (!outcome.ok) {
    throw err(outcome.code === 'timeout' ? 'timeout' : 'cli-failed', {
      detail: `evaluation session failed: ${outcome.code}`,
      userMessage: EVALUATOR_SILENT_MESSAGE,
    });
  }

  const parsed = parseEvaluatorOutput(outcome.output);
  if (!parsed.ok) {
    const failureId = newCorrelationId();
    log({
      level: 'error',
      event: 'eval-verdict-unparseable',
      component: 'C6',
      correlationId: failureId,
      sessionId: active.session.id,
      reason: parsed.reason,
      raw: outcome.output,
    });
    throw err('cli-failed', {
      detail: `evaluator output rejected: ${parsed.reason}`,
      userMessage: EVALUATOR_SILENT_MESSAGE,
    });
  }

  const correlationId = newCorrelationId();
  const gated = applyTeachBackGate(active, toEvalVerdict(parsed.value.verdict), message.text);
  const checked = enforcePassCriteria(gated, active.script.passCriteria, correlationId);
  const ladder = applyHintLadder(
    checked,
    currentAssistLevel(active.session.turns),
    active.target.kind === 'capstone' ? CAPSTONE_ASSISTED_PASS_THRESHOLD : ASSISTED_PASS_THRESHOLD,
  );
  const composed = compose(active, parsed.value, ladder.verdict, ladder.mode);
  const verdict = composed.verdict;

  const evaluatorTurn: EvalTurn = {
    id: evaluatorTurnId(active.session.turns.length, verdict.outcome),
    role: 'evaluator',
    text: composed.text,
    assistLevel: verdict.assistLevel,
    angle: composed.angle,
    mode: composed.mode,
    selfAssessment: null,
    at: nowIso(),
  };
  let session = appendTurn(deps, active.session, evaluatorTurn);

  let completion: EvalTurnResult['completion'] = null;
  // WHY (F10 AC): the calibration comparison belongs to the moment the module is passed,
  // so it is computed here on the passing turn and returned with it — never fetched later.
  let calibration: CalibrationView | null = null;
  if (grantsCompletion(verdict.outcome) && affectsCompletion(active.target) && active.node !== null) {
    const result = deps.store.completeModule(active.node.id, verdict);
    completion = { moduleId: result.module.id, unlocked: result.unlocked };
    const computed = computeCalibration(deps.store, active.node.id, session);
    calibration = computed === null ? null : toCalibrationView(computed);
    // WHY here: this pass is the moment lessons stop being not-yet-recommended, and the
    // ones it just unlocked may have no content behind them. Left alone the learner
    // follows "this opened up Lesson 7" into an empty page and has to go back to the
    // subject and ask for the writing themselves. The graph is re-read from the store so
    // the states this transaction just changed are the ones the window is computed from.
    prepareAvailable(
      deps.orchestrator,
      active.topic,
      deps.store.modules.graph(active.topic.id),
      readTopicState(deps.dataRoot, active.topic.id),
    );
  }

  // WHY (F7): a review taken through the evaluator chat is a real retrieval attempt and can
  // really fail, and a failure is the one review outcome `completeModule` never sees —
  // that transaction refuses anything but a passing verdict. Without this the "review
  // failed -> Again" row of the grade table in docs/spaced-repetition.md §3 has no caller,
  // and a learner could fail the same review every month while its interval kept growing as
  // though nothing had happened. `recordGradedReview` is also what re-flags the lesson
  // `needs-review`, which is the second half of F7's missed-review path.
  //
  // WHY only the first terminal fail of a session: once the hint ladder is exhausted every
  // later failing turn is also `fail`, and a learner who keeps trying after the ladder runs
  // out has had one failed retrieval, not four.
  //
  // WHY the existence check rather than catching: reaching a review target normally implies
  // a scheduled row, but the row can be absent if the schedule was cleared underneath the
  // open session, and losing the learner's turn to a not-found throw would be the worse
  // failure. There is simply nothing to reschedule in that case.
  if (
    active.target.kind === 'review' &&
    verdict.outcome === 'fail' &&
    active.node !== null &&
    !evaluatorOutcomes(active.session.turns).includes('fail') &&
    deps.store.reviews.get(active.node.id) !== null
  ) {
    recordGradedReview(deps.store, active.node.id, 'again');
  }

  let remedialQueued = false;
  // WHY (F4 path): a test-out failure routes the learner into the normal lesson,
  // not the remedial loop — there was no instructional input to repeat.
  const remedialEligible = active.target.kind === 'module' || active.target.kind === 'review';
  if (
    remedialEligible &&
    active.node !== null &&
    shouldRequestRemedial(consecutiveFailuresOf(session.turns), verdict)
  ) {
    const requested = requestRemedial(
      deps.orchestrator,
      active.topic,
      active.node.id,
      conceptFor(verdict, active.node.title),
    );
    remedialQueued = requested.queued;
    session = appendTurn(deps, session, {
      id: evaluatorTurnId(session.turns.length, 'continue'),
      role: 'evaluator',
      text: requested.message,
      assistLevel: verdict.assistLevel,
      angle: null,
      mode: 'explanation',
      selfAssessment: null,
      at: nowIso(),
    });
  }

  log({
    level: 'info',
    event: 'eval-turn',
    component: 'C6',
    correlationId,
    sessionId: session.id,
    turnCount: session.turns.length,
    outcome: verdict.outcome,
    assistLevel: verdict.assistLevel,
    angle: composed.angle,
    remedialQueued,
  });

  return evalTurnResultSchema.parse({
    session: hydrateSession(session),
    evaluatorTurn,
    verdict,
    completion,
    remedialQueued,
    calibration,
  });
}
