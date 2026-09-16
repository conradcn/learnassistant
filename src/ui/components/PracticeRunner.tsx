// FRACTAL: implements F8 | component C10
'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PracticeSession } from '@/shapes';
import { applyOptimisticAnswer, practiceAnswerView, settleAnswer } from '@/practice/optimistic';
import { rollbackPractice } from '@/ui/optimistic';
import { answerPractice } from '@/ui/api-client';
import { MathText } from '@/ui/components/MathText';
import {
  answeredLine,
  PRACTICE_GOT_IT,
  PRACTICE_INTRO,
  PRACTICE_MISSED,
  PRACTICE_SKIP,
  PRACTICE_STOP,
  practiceSummaryHeading,
  ratingAnnouncement,
  stoppedLine,
} from '@/ui/practice-copy';

export type PracticeRunnerProps = {
  session: PracticeSession;
  /** Subject name per subject the questions were drawn from, keyed by subject. */
  subjects?: Readonly<Record<string, string>>;
  onFinished?: (session: PracticeSession) => void;
};

/** WHY (F8): skipping sets a question aside for this run only — it records nothing. */
export function nextToAsk(session: PracticeSession, setAside: readonly number[]): number {
  return session.questions.findIndex(
    (question, position) => !question.answered && !setAside.includes(position),
  );
}

/**
 * WHY (F8 AC): each mark is applied on the tick it is clicked and written afterwards, so
 * no control waits on the round trip; stopping only ends the run, because every answer
 * was already recorded as it happened.
 */
export function PracticeRunner({ session, subjects, onFinished }: PracticeRunnerProps): ReactNode {
  const [view, setView] = useState(() => practiceAnswerView(session));
  const [stopped, setStopped] = useState(false);
  const [setAside, setSetAside] = useState<number[]>([]);
  const [rated, setRated] = useState('');

  const index = nextToAsk(view.session, setAside);
  const done = index === -1;
  const over = stopped || done;

  /**
   * WHY focus is moved by hand when a run ends: the button the learner just pressed is
   * inside the subtree React replaces with the summary, so the browser drops focus onto
   * `<body>` and a keyboard user is returned to the top of the document with nothing
   * said. Sending focus to the summary heading both puts them where the new content is
   * and, because the heading is what gets read on focus, tells them the run is over.
   */
  const summaryRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (over) summaryRef.current?.focus();
  }, [over]);

  const mark = (correct: boolean): void => {
    if (index === -1) return;
    const applied = applyOptimisticAnswer(view, index, correct);
    setView(applied.view);
    // WHY the optimistic view and not the settled one: the announcement is the learner's
    // confirmation that the press landed, so it is owed on the same tick the press is,
    // exactly like every control here that does not wait on the round trip. A write that
    // fails rolls the count back and speaks through the error region below.
    setRated(ratingAnnouncement(applied.view.session, correct));
    void answerPractice(applied.view.session.id, index, correct).then((response) => {
      setView((current) =>
        response.ok
          ? settleAnswer(current, applied.key, response.data)
          : rollbackPractice(current, applied.key, response.error),
      );
    });
  };

  const skip = (): void => {
    if (index === -1) return;
    setSetAside((current) => [...current, index]);
  };

  const stop = (): void => {
    setStopped(true);
    onFinished?.({ ...view.session, stoppedEarly: true });
  };

  const answered = view.session.questions.filter((question) => question.answered);
  const source = index === -1 ? undefined : subjects?.[view.session.questions[index].topicId];

  return (
    <section data-testid="practice-runner">
      <p className="la-muted">{PRACTICE_INTRO}</p>
      <p data-testid="practice-progress">{answeredLine(view.session)}</p>
      {view.error === null ? null : (
        <p className="la-error" role="alert" data-testid="practice-error">
          {view.error}
        </p>
      )}
      {/* WHY a region that is always here rather than one that appears with the summary:
          a live region announces what changes INSIDE it, and a region inserted into the
          page already holding its text is announced by no screen reader reliably. This
          one is present from the first question and speaks for every rating and for the
          ending. It repeats what the heading says because focus and announcement reach
          two different people — a sighted keyboard user and a screen-reader user.

          WHY this one region rather than also marking the visible progress line live:
          both would carry the same count, and two polite regions changing on the same
          tick get read one after the other — the learner hears the tally twice. */}
      <p className="la-visually-hidden" role="status" data-testid="practice-announcement">
        {over
          ? `${practiceSummaryHeading(stopped)}. ${stopped ? stoppedLine(view.session) : answeredLine(view.session)}`
          : rated}
      </p>
      {over ? (
        <div className="la-card" data-testid="practice-summary">
          {/* tabIndex -1: a heading is not focusable on its own, and this one is the
              anchor focus is moved to when the run ends. It stays out of the Tab order. */}
          <h2 ref={summaryRef} tabIndex={-1} data-testid="practice-summary-heading">
            {practiceSummaryHeading(stopped)}
          </h2>
          <p>{stopped ? stoppedLine(view.session) : answeredLine(view.session)}</p>
          <ul className="la-list" data-testid="practice-kept">
            {answered.map((question, position) => (
              <li key={`${question.moduleId}-${position}`} data-testid="practice-kept-question">
                <MathText text={question.text} />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="la-card" data-testid="practice-question">
          {source === undefined ? null : (
            <p className="la-muted" data-testid="practice-source">
              {source}
            </p>
          )}
          <MathText as="p" text={view.session.questions[index].text} />
          <div className="la-row">
            <button type="button" data-testid="practice-got-it" onClick={(): void => mark(true)}>
              {PRACTICE_GOT_IT}
            </button>
            <button type="button" data-testid="practice-missed" onClick={(): void => mark(false)}>
              {PRACTICE_MISSED}
            </button>
          </div>
          <div className="la-row">
            <button type="button" data-testid="practice-skip" onClick={skip}>
              {PRACTICE_SKIP}
            </button>
            {/* WHY: ending the run is not an answer, so it stays quiet and apart from them. */}
            <button
              type="button"
              data-testid="practice-stop"
              style={{ background: 'transparent', color: 'var(--muted)' }}
              onClick={stop}
            >
              {PRACTICE_STOP}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
