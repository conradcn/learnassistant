// FRACTAL: implements F4, F9, F13 | component C10
'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { ApiResponse, EvalTurn, EvalTurnResult, LearnerMessage, SelfAssessment } from '@/shapes';
import { awaitsReply, EMPTY_CHAT, settleSend, type ChatView } from '@/eval/optimistic';
import { sendMessageOp } from '@/ui/optimistic';
import { useOptimisticView } from '@/ui/lesson';
import { ChatTurn, ROLE_LABEL } from '@/ui/components/ChatTurn';

export type ChatPanelProps = {
  draftKey: string;
  turns: EvalTurn[];
  composerLabel: string;
  sendLabel: string;
  emptyMessage: string;
  persist: (message: LearnerMessage) => Promise<ApiResponse<EvalTurnResult>>;
  /**
   * WHY (F4 invariant): asks the server to finish a turn that is already in the
   * transcript. Supplied wherever a conversation can be reopened; the panel calls it on
   * its own when the transcript it is handed ends on the learner, and never otherwise.
   */
  resume?: () => Promise<ApiResponse<EvalTurnResult | null>>;
  onResult: (result: EvalTurnResult) => void;
};

const CONFIDENCE_VALUES: readonly (1 | 2 | 3 | 4 | 5)[] = [1, 2, 3, 4, 5];

function readDraft(key: string): string {
  if (typeof sessionStorage === 'undefined') return '';
  return sessionStorage.getItem(key) ?? '';
}

function writeDraft(key: string, value: string): void {
  if (typeof sessionStorage === 'undefined') return;
  if (value.length === 0) sessionStorage.removeItem(key);
  else sessionStorage.setItem(key, value);
}

export function ChatPanel({
  draftKey,
  turns,
  composerLabel,
  sendLabel,
  emptyMessage,
  persist,
  resume,
  onResult,
}: ChatPanelProps): ReactNode {
  const view = useOptimisticView<ChatView>({ ...EMPTY_CHAT, turns });
  const [confidence, setConfidence] = useState<SelfAssessment['confidence'] | null>(null);
  const [critique, setCritique] = useState('');
  const restored = useRef(false);
  const update = view.update;
  const state = view.state;
  // WHY it is not a pending op: nothing is being written optimistically here. The message
  // is already saved and already on screen; what is missing is the reply, so the only
  // state to hold is that the tutor is working on it and whether that failed.
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  // WHY (state lifecycle): a reload must not lose typed text, so the draft is read back
  // after hydration rather than during it.
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const draft = readDraft(draftKey);
    if (draft.length === 0) return;
    update((current) => ({ ...current, composer: { ...current.composer, text: draft } }));
  }, [draftKey, update]);

  /**
   * WHY (F4 invariant): a turn is written to the transcript before the model is called, so
   * an interruption in between leaves the conversation owing the learner a reply with
   * nothing running to produce it. Reloading the page used to land exactly there — the last
   * word was the learner's, the composer sat under it, and the tutor was never coming back;
   * the only way out was to type the same thing again. Opening a conversation in that state
   * is a request to finish it, so the panel asks for the owed reply itself.
   */
  const resumed = useRef(false);
  const startResume = useCallback((): void => {
    if (resume === undefined) return;
    setResumeError(null);
    setResuming(true);
    void resume().then((response) => {
      setResuming(false);
      if (!response.ok) {
        setResumeError(response.error.message);
        return;
      }
      // WHY null is silence: the reply was owed to someone, and another tab or an earlier
      // attempt landing it first is not a failure — the transcript this panel holds is just
      // one read behind, and the next result or reload carries it.
      const result = response.data;
      if (result === null) return;
      update((current) => settleSend(current, '', result));
      onResult(result);
    });
    // `onResult` is re-created every render; `resumed` keeps this to one automatic call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume, update]);

  useEffect(() => {
    if (resumed.current || resume === undefined) return;
    if (!awaitsReply(turns)) return;
    resumed.current = true;
    startResume();
  }, [turns, resume, startResume]);

  const changeText = (text: string): void => {
    writeDraft(draftKey, text);
    update((current) => ({ ...current, composer: { ...current.composer, text } }));
  };

  const submit = (): void => {
    const text = state.composer.text.trim();
    if (text.length === 0) return;
    const selfAssessment: SelfAssessment | null =
      confidence === null ? null : { confidence, critique: critique.trim() };
    const message: LearnerMessage = { text, selfAssessment };
    writeDraft(draftKey, '');
    setConfidence(null);
    setCritique('');
    // WHY: the page needs the verdict (completion, newly opened lessons) from the very
    // same round trip the runner reconciles against — never a second fetch.
    const carry = (): Promise<ApiResponse<EvalTurnResult>> =>
      persist(message).then((response) => {
        if (response.ok) onResult(response.data);
        return response;
      });
    view.run<EvalTurnResult>(sendMessageOp(message, carry));
  };

  const send = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    submit();
  };

  // WHY (F4 AC): the failure message promises Retry, so the control has to exist. The
  // rollback has already put the learner's text back in the composer, so retrying is
  // the same send again — and the text is written back to the draft store here so a
  // reload during the outage does not lose it either.
  const failedText = state.composer.error === null ? '' : state.composer.text;
  useEffect(() => {
    if (failedText.length > 0) writeDraft(draftKey, failedText);
  }, [draftKey, failedText]);

  return (
    <section data-testid="chat-panel">
      {state.turns.length === 0 && state.pending.length === 0 ? (
        <p className="la-empty" data-testid="chat-empty">
          {emptyMessage}
        </p>
      ) : (
        <ol className="la-list" data-testid="chat-transcript">
          {state.turns.map((turn) => (
            <ChatTurn key={turn.id} role={turn.role} text={turn.text} />
          ))}
          {state.pending.map((pending) => (
            <ChatTurn
              key={pending.key}
              role="learner"
              text={pending.text}
              label={`${ROLE_LABEL.learner} · sending`}
              testId="chat-turn-pending"
            />
          ))}
          {resuming ? (
            <li className="la-card" data-testid="chat-turn-resuming">
              <p className="la-muted" role="status">
                {ROLE_LABEL.evaluator} · picking your last answer back up
              </p>
            </li>
          ) : null}
        </ol>
      )}

      <form onSubmit={send}>
        <label htmlFor="chat-text">{composerLabel}</label>
        <textarea
          id="chat-text"
          data-testid="chat-text"
          rows={5}
          value={state.composer.text}
          onChange={(event) => changeText(event.target.value)}
        />
        <fieldset data-testid="self-assessment">
          <legend>Before you send — how sure are you? (you can skip this)</legend>
          <div className="la-row">
            {CONFIDENCE_VALUES.map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name="confidence"
                  data-testid={`confidence-${value}`}
                  checked={confidence === value}
                  onChange={() => setConfidence(value)}
                />
                {value === 1 ? 'Guessing' : value === 5 ? 'Certain' : String(value)}
              </label>
            ))}
          </div>
          <label htmlFor="critique">What part of your answer feels weakest?</label>
          <input
            id="critique"
            data-testid="critique"
            value={critique}
            onChange={(event) => setCritique(event.target.value)}
          />
        </fieldset>
        <button type="submit" data-testid="chat-send">
          {sendLabel}
        </button>
      </form>

      {state.composer.error === null ? null : (
        <div className="la-error" role="alert" data-testid="chat-composer-error">
          <p>{state.composer.error}</p>
          <button type="button" data-testid="chat-retry" onClick={submit}>
            Retry
          </button>
        </div>
      )}
      {resumeError === null ? null : (
        <div className="la-error" role="alert" data-testid="chat-resume-error">
          <p>{resumeError}</p>
          <button type="button" data-testid="chat-resume-retry" onClick={startResume}>
            Retry
          </button>
        </div>
      )}
      {view.error === null ? null : (
        <p className="la-error" role="alert" data-testid="chat-error">
          {view.error}
        </p>
      )}
    </section>
  );
}
