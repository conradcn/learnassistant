// FRACTAL: implements F4 | component C10
'use client';
import Link from 'next/link';
import { use, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  ApiResponse,
  CalibrationView,
  EvalSession,
  EvalTurnResult,
  LearnerMessage,
  ModuleId,
} from '@/shapes';
import { moduleIdSchema } from '@/shapes';
import { evaluatorOutcomes } from '@/eval/turn-id';
import {
  getModule,
  openEvaluation,
  restartEvaluation,
  continueEvaluation,
  resumeEvaluation,
  sendEvaluationMessage,
  type ModuleDetailView,
} from '@/ui/api-client';
import { fromResponse, LOADING, type LoadState } from '@/ui/load-state';
import { LoadStateBoundary } from '@/ui/components/LoadStateBoundary';
import { ChatPanel } from '@/ui/components/ChatPanel';
import { ChatTurn } from '@/ui/components/ChatTurn';
import { CalibrationCard } from '@/ui/components/CalibrationCard';
import { PassCelebration } from '@/ui/components/PassCelebration';
import { MathText } from '@/ui/components/MathText';
import { useStartWork } from '@/ui/lesson';
import { setEvalSession } from '@/ui/store';

const BAD_LINK = 'That link does not point at a lesson we can open.';

type PassOutcome = 'pass' | 'assisted-pass';

/**
 * WHY one line for both outcomes: whether the pass needed hints is a review-scheduling
 * input (F7 brings an assisted pass back sooner), not news for the learner. Reporting it
 * here would grade a finished lesson without giving them anything to act on.
 */
function passLine(): string {
  return 'That one is done. Nice work.';
}

/**
 * WHY: the celebration used to fire only on the live turn, which meant it was invisible
 * to everyone it was meant for the second time they looked — and completely absent for a
 * lesson passed before it existed, or for a pass registered after the fact when the
 * criteria gate had wrongly swallowed it. A conversation carries its verdict in its turn
 * ids (turn-id.ts) and nowhere else, so a passed transcript can say so on every visit.
 */
function passedOutcomeOf(turns: EvalSession['turns']): PassOutcome | null {
  const outcomes = evaluatorOutcomes(turns);
  for (const outcome of [...outcomes].reverse()) {
    if (outcome === 'pass' || outcome === 'assisted-pass') return outcome;
  }
  return null;
}

function outcomeLine(result: EvalTurnResult): string {
  if (result.verdict.outcome === 'pass' || result.verdict.outcome === 'assisted-pass') {
    return passLine();
  }
  if (result.remedialQueued) {
    return 'We are putting together a shorter explanation of the part that is not landing yet.';
  }
  return 'Keep going — read what came back and answer again.';
}

function unlockedLine(count: number): string {
  if (count === 0) return 'Nothing new opened up from this one.';
  if (count === 1) return 'One more lesson is now open to you.';
  return `${count} more lessons are now open to you.`;
}

export default function EvaluationPage({ params }: { params: Promise<{ id: string }> }): ReactNode {
  const raw = use(params).id;
  const parsed = moduleIdSchema.safeParse(raw);
  const moduleId: ModuleId | null = parsed.success ? parsed.data : null;

  const [detail, setDetail] = useState<LoadState<ModuleDetailView>>(LOADING);
  const [session, setSession] = useState<EvalSession | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  // WHY separate from `outcome`: the outcome line reads the same way wherever it lands,
  // but only a passing turn earns the celebration, and `finished` is also true on a
  // resumed conversation that was passed days ago. This is set on the turn itself.
  const [passed, setPassed] = useState<'pass' | 'assisted-pass' | null>(null);
  const [unlocked, setUnlocked] = useState<string | null>(null);
  const [calibration, setCalibration] = useState<CalibrationView | null>(null);
  // WHY (H3): opening a session is a slow round trip with nothing to show for it, so the
  // learner is told it is under way and cannot start a second one while it runs.
  const [starting, setStarting] = useState(false);
  // WHY: once the module is done the answer box is dead weight that hides the result, so
  // the finished transcript replaces it rather than sitting under it.
  const [finished, setFinished] = useState(false);
  // WHY (F4 AC): "go straight to the questions" and "start the lesson's conversation" are
  // two different entries with two different defaults. The intent is carried in the URL and
  // read here, so the page the learner lands on emphasises the thing they actually clicked
  // and says which mode is about to run. Read from the location rather than useSearchParams
  // so this stays a plain client read with no suspense boundary around the page.
  const [testOut, setTestOut] = useState(false);

  // WHY: `finished` is not a fact the page invents — it is what the transcript already
  // says. Restoring a passed conversation on load has to land on the same screen the
  // learner left, so both the fresh result and a resumed session go through here.
  const adopt = useCallback((next: EvalSession): void => {
    setSession(next);
    setEvalSession(next);
    setFinished(next.status === 'passed');
  }, []);

  // WHY: the panel keeps optimistic state of its own, and a restart replaces the whole
  // transcript under an unchanged session id. Bumping this remounts it so nothing from
  // the discarded conversation survives.
  const [generation, setGeneration] = useState(0);
  const [restarting, setRestarting] = useState(false);

  const outcomeRef = useRef<HTMLDivElement | null>(null);

  // WHY derived rather than stored: this is a pure read of the transcript the page
  // already holds, and it has to survive a reload, so there is no state to keep in sync.
  const restoredPass = session === null ? null : passedOutcomeOf(session.turns);

  const work = useStartWork();
  /**
   * WHY (H2): `starting` only goes up once the request is actually in flight, and the press
   * happens a tick earlier. Without folding `work.awaiting` in, the page re-rendered its
   * untouched invitation with both buttons live for that whole window, so a session that
   * was already under way looked like it had not landed and could be started a second time.
   */
  const opening = starting || work.awaiting;

  const load = useCallback((): void => {
    if (moduleId === null) {
      setDetail({ status: 'error', error: { code: 'validation', message: BAD_LINK, correlationId: 'c_browser' } });
      return;
    }
    setDetail(LOADING);
    void getModule(moduleId).then((response) => setDetail(fromResponse(response, () => false)));
  }, [moduleId]);

  useEffect(load, [load]);

  // WHY: the mode is read before anything can auto-start, so the session that opens is the
  // one the learner clicked through to and not always the default.
  const [modeRead, setModeRead] = useState(false);
  useEffect(() => {
    setTestOut(new URLSearchParams(window.location.search).get('mode') === 'test-out');
    setModeRead(true);
  }, []);

  // WHY (F10 AC): the calibration and what it opened up are the point of finishing, and
  // they land below a tall transcript, so the page is brought to them.
  useEffect(() => {
    if (outcome === null) return;
    outcomeRef.current?.scrollIntoView?.({ block: 'center' });
  }, [outcome]);

  const start = (view: ModuleDetailView, kind: 'module' | 'test-out'): void => {
    setMessage(null);
    work.run(() => {
      setStarting(true);
      return openEvaluation({ kind, moduleId: view.module.id }).then((response) => {
        // Cleared on failure too: a stuck "starting" line with no way back would strand
        // the learner on a screen with nothing to press.
        setStarting(false);
        if (response.ok) {
          adopt(response.data);
          return;
        }
        setMessage(response.error.message);
      });
    });
  };

  /**
   * WHY: landing on this page IS the request — the learner clicked "start the conversation"
   * to get here. Making them press a second button on arrival only delayed the tutor, so the
   * session opens on its own. `autoStarted` makes that exactly once per page, and the manual
   * buttons stay for the case where opening failed and they want another go.
   *
   * WHY the resume first: a reload is not a new request. The conversation for this lesson
   * is already on the server, and restoring it is a pure read — no model turn and nothing
   * spent. Only when there is nothing to come back to does this open one.
   */
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!modeRead || detail.status !== 'ready' || session !== null || autoStarted.current) return;
    autoStarted.current = true;
    const view = detail.data;
    const kind = testOut ? 'test-out' : 'module';
    setStarting(true);
    void resumeEvaluation({ kind, moduleId: view.module.id }).then((response) => {
      setStarting(false);
      if (response.ok && response.data !== null) {
        adopt(response.data);
        return;
      }
      start(view, kind);
    });
    // `start` is re-created every render; the ref above is what keeps this to one call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeRead, detail, session, testOut, adopt]);

  // WHY (F4): the manual counterpart to all of the above — the learner says, explicitly,
  // that this conversation should be thrown away and the opening question asked again.
  const restart = (open: EvalSession): void => {
    setMessage(null);
    setRestarting(true);
    void restartEvaluation(open.id).then((response) => {
      setRestarting(false);
      if (!response.ok) {
        setMessage(response.error.message);
        return;
      }
      // The draft belongs to the discarded conversation; it must not resurface in the new one.
      if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(`eval-draft:${open.id}`);
      setOutcome(null);
      setPassed(null);
      setUnlocked(null);
      setCalibration(null);
      setGeneration((n) => n + 1);
      adopt(response.data);
    });
  };


  /**
   * Sends one turn.
   *
   * WHY there is nothing in front of it: each chat turn is its own Claude CLI session, and
   * the learner pressing send is the whole authorisation. The composer's promise settles on
   * the server's answer and on nothing else.
   */
  const persist =
    (open: EvalSession) =>
    (learnerMessage: LearnerMessage): Promise<ApiResponse<EvalTurnResult>> => {
      setMessage(null);
      return sendEvaluationMessage(open.id, learnerMessage.text, learnerMessage.selfAssessment);
    };

  return (
    <>
    <LoadStateBoundary
      state={detail}
      label="these questions"
      emptyMessage="There is nothing to be asked about here yet."
      onRetry={load}
    >
      {(view): ReactNode => (
        <>
          <p className="la-row">
            <Link href={`/modules/${view.module.id}`}>Back to the lesson</Link>
            <Link href={`/topics/${view.module.topicId}`}>Back to the whole subject</Link>
          </p>
          <h1>Talking through: <MathText text={view.module.title} /></h1>

          {session === null ? (
            <section className="la-card" data-testid="eval-start">
              {opening ? (
                <p role="status" data-testid="eval-starting">
                  Getting your tutor ready. This takes a few seconds — you can wait here.
                </p>
              ) : testOut ? (
                <p data-testid="test-out-mode">
                  Going straight to the questions on this one — no reading first. If it turns out
                  you would rather work through the lesson, you can still start there.
                </p>
              ) : (
                <p>
                  This is a conversation, not a test. Your tutor asks, you answer in your own words, and
                  you can take as long as you like.
                </p>
              )}
              <div className="la-row">
                <button
                  type="button"
                  className={testOut ? undefined : 'la-primary'}
                  data-testid="start-evaluation"
                  disabled={opening}
                  onClick={() => start(view, 'module')}
                >
                  Start the conversation
                </button>
                <button
                  type="button"
                  className={testOut ? 'la-primary' : undefined}
                  data-testid="start-test-out"
                  disabled={opening}
                  onClick={() => start(view, 'test-out')}
                >
                  Skip the lesson, test me
                </button>
              </div>
            </section>
          ) : finished ? (
            <section data-testid="chat-panel">
              {/* WHY only when `passed` is null: a turn that has just passed already
                  renders the celebration down in the outcome region, next to the
                  calibration it belongs with. This is the returning visit. */}
              {passed !== null || restoredPass === null ? null : (
                <PassCelebration
                  title={view.module.title}
                  line={passLine()}
                />
              )}
              <p className="la-muted" data-testid="eval-finished">
                This conversation is done and saved. It will be here whenever you come back.
              </p>
              <ol className="la-list" data-testid="chat-transcript">
                {session.turns.map((turn) => (
                  <ChatTurn key={turn.id} role={turn.role} text={turn.text} />
                ))}
              </ol>
            </section>
          ) : (
            <ChatPanel
              key={`${session.id}:${generation}`}
              draftKey={`eval-draft:${session.id}`}
              turns={session.turns}
              composerLabel="Your answer — in your own words, all the way through"
              sendLabel="Send"
              emptyMessage="Your tutor is about to open with a question. Say hello, or dive straight in."
              persist={persist(session)}
              // WHY: a conversation whose last word is the learner's is owed a reply that
              // no request is producing any more. Landing back on it asks for that reply.
              resume={() => continueEvaluation(session.id)}
              onResult={(result) => {
                adopt(result.session);
                setOutcome(outcomeLine(result));
                setUnlocked(result.completion === null ? null : unlockedLine(result.completion.unlocked.length));
                // WHY (F10 AC): shown once, right here, on the turn that passed the module.
                if (result.calibration !== null) setCalibration(result.calibration);
                if (result.verdict.outcome === 'pass' || result.verdict.outcome === 'assisted-pass') {
                  setPassed(result.verdict.outcome);
                  setFinished(true);
                }
              }}
            />
          )}

          {session === null ? null : (
            <p className="la-row">
              <button
                type="button"
                data-testid="restart-evaluation"
                disabled={restarting}
                onClick={() => restart(session)}
              >
                {restarting ? 'Starting over…' : 'Start this conversation over'}
              </button>
            </p>
          )}

          <div ref={outcomeRef}>
            {outcome === null ? null : passed === null ? (
              <p data-testid="eval-outcome">{outcome}</p>
            ) : (
              <PassCelebration
                title={view.module.title}
                line={outcome}
              />
            )}
            {calibration === null ? null : <CalibrationCard view={calibration} />}
            {unlocked === null ? null : (
              <p data-testid="eval-unlocked">
                {unlocked}{' '}
                <Link href={`/topics/${view.module.topicId}`}>See what is open now</Link>
              </p>
            )}
          </div>
          {message === null && work.error === null ? null : (
            <p className="la-error" role="alert" data-testid="eval-message">
              {message ?? work.error}
            </p>
          )}
        </>
      )}
    </LoadStateBoundary>
    </>
  );
}
