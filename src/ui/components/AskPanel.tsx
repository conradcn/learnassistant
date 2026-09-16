// FRACTAL: implements F3 | component C10
'use client';
import { useState, type FormEvent, type ReactNode } from 'react';
import type { ApiResponse, LessonQuestion } from '@/shapes';
import { Markdown } from '@/ui/components/Markdown';
import { MathText } from '@/ui/components/MathText';

export type AskPanelProps = {
  /** Everything already asked about this lesson, oldest first. */
  asked: LessonQuestion[];
  ask: (question: string) => Promise<ApiResponse<LessonQuestion>>;
};

/**
 * WHY (F3): the lesson is a page with nobody on the other side of it, and the only way to
 * ask about a sentence that did not land was to start the evaluation — which is a graded
 * conversation about whether you understood, not a place to admit that you did not. This
 * is the hand raised in the middle of the lesson: ungraded, unrecorded against progress,
 * and available before the questions rather than instead of them.
 *
 * WHY it is not optimistic: there is nothing to show optimistically. The whole point of
 * the press is an answer that only the server has, so the panel shows the question it is
 * waiting on and keeps the text until the answer lands.
 */
export function AskPanel({ asked, ask }: AskPanelProps): ReactNode {
  const [text, setText] = useState('');
  const [answered, setAnswered] = useState<LessonQuestion[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const history = [...asked, ...answered];

  const send = (question: string): void => {
    setError(null);
    setPending(question);
    void ask(question).then((response) => {
      setPending(null);
      if (!response.ok) {
        // The text goes back in the box: a failed question the learner has to retype is a
        // question they do not ask again.
        setText(question);
        setError(response.error.message);
        return;
      }
      setAnswered((current) => [...current, response.data]);
      setText('');
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmed = text.trim();
    if (trimmed.length === 0 || pending !== null) return;
    setText('');
    send(trimmed);
  };

  return (
    <section className="la-card" data-testid="ask-panel">
      <h3>Ask a question about this</h3>
      <p className="la-muted">
        Anything in this lesson that did not land. Nothing here is marked, and it does not
        count towards finishing the lesson.
      </p>

      {history.length === 0 ? null : (
        <ol className="la-list" data-testid="ask-history">
          {history.map((entry, index) => (
            <li key={`${index}:${entry.question}`} className="la-card" data-testid="ask-exchange">
              <p className="la-muted">You asked</p>
              <MathText as="p" text={entry.question} />
              <p className="la-muted">Your tutor</p>
              <Markdown markdown={entry.answer} testId="ask-answer" />
            </li>
          ))}
        </ol>
      )}

      {pending === null ? null : (
        <div className="la-card" data-testid="ask-pending">
          <p className="la-muted">You asked</p>
          <MathText as="p" text={pending} />
          <p role="status">Your tutor is reading that. It takes a few seconds.</p>
        </div>
      )}

      <form onSubmit={submit}>
        <label htmlFor="ask-text">Your question</label>
        <textarea
          id="ask-text"
          data-testid="ask-text"
          rows={3}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" data-testid="ask-send" disabled={pending !== null}>
          {pending === null ? 'Ask' : 'Asking…'}
        </button>
      </form>

      {error === null ? null : (
        <div className="la-error" role="alert" data-testid="ask-error">
          <p>{error}</p>
        </div>
      )}
    </section>
  );
}
