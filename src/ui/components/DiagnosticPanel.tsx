// FRACTAL: implements F1 | component C10
'use client';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { ApiResponse, DiagnosticTurnResult } from '@/shapes';
import { MathText } from '@/ui/components/MathText';

export type DiagnosticPanelProps = {
  step: (request: { answer?: string | null; skip?: boolean }) => Promise<ApiResponse<DiagnosticTurnResult>>;
  /** Called once the diagnostic is over, whether it ran to the end or was skipped. */
  onDone: (result: DiagnosticTurnResult) => void;
};

/**
 * WHY (F1): the learner ticked "ask me a few questions first", and the level radio is a
 * label, not what they know. This is the short conversation that finds out, before the
 * lessons are planned — skippable at any point with no penalty.
 */
export function DiagnosticPanel({ step, onDone }: DiagnosticPanelProps): ReactNode {
  const [history, setHistory] = useState<{ question: string; answer: string }[]>([]);
  const [question, setQuestion] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const send = (request: { answer?: string | null; skip?: boolean }): void => {
    setBusy(true);
    setError(null);
    void step(request).then((response) => {
      setBusy(false);
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      if (request.answer && question !== null) {
        setHistory((h) => [...h, { question, answer: request.answer as string }]);
        setText('');
      }
      if (response.data.question === null) {
        onDone(response.data);
        return;
      }
      setQuestion(response.data.question);
    });
  };

  useEffect(() => {
    // Guarded so React's development double-invoke does not spend two model turns.
    if (started.current) return;
    started.current = true;
    send({ answer: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmed = text.trim();
    if (trimmed.length === 0 || busy) return;
    send({ answer: trimmed });
  };

  return (
    <section className="la-card" data-testid="diagnostic-panel">
      <h3>A few questions first</h3>
      <p className="la-muted">
        So the lessons skip what you already know. Nothing here is marked — answer in your own
        words, say you do not know, or skip ahead whenever you like.
      </p>

      {history.length === 0 ? null : (
        <ol className="la-list">
          {history.map((entry, index) => (
            <li key={index} className="la-card" data-testid="diagnostic-exchange">
              <MathText as="p" text={entry.question} />
              <p className="la-muted">You said</p>
              <MathText as="p" text={entry.answer} />
            </li>
          ))}
        </ol>
      )}

      {question === null ? null : (
        <div data-testid="diagnostic-question">
          <MathText as="p" text={question} />
        </div>
      )}
      {busy ? (
        <p role="status" className="la-muted" data-testid="diagnostic-pending">
          Your tutor is thinking of a question. It takes a few seconds.
        </p>
      ) : null}

      <form onSubmit={submit}>
        <label htmlFor="diagnostic-answer">Your answer</label>
        <textarea
          id="diagnostic-answer"
          data-testid="diagnostic-answer"
          rows={3}
          value={text}
          disabled={question === null}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="la-row">
          <button type="submit" data-testid="diagnostic-send" disabled={busy || question === null}>
            Answer
          </button>
          <button type="button" data-testid="diagnostic-skip" disabled={busy} onClick={() => send({ skip: true })}>
            Skip the rest
          </button>
        </div>
      </form>

      {error === null ? null : (
        <p className="la-error" role="alert" data-testid="diagnostic-error">
          {error}
        </p>
      )}
    </section>
  );
}
