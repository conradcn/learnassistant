// FRACTAL: implements F3, F14 | component C10
'use client';
import type { ReactNode } from 'react';
import type { ApiResponse, EntryDecision, ModuleNode, Reflection, WarmUpRecord } from '@/shapes';
import { DegradedCard } from '@/ui/components/DegradedCard';
import { NotWrittenCard } from '@/ui/components/NotWrittenCard';
import { ExplanationView } from '@/ui/components/ExplanationView';
import { LessonBlocks } from '@/ui/components/LessonBlocks';
import { MathText } from '@/ui/components/MathText';
import { VisualizationView } from '@/ui/components/VisualizationView';
import { WarmUpGate } from '@/ui/components/WarmUpGate';
import {
  advisoryNote,
  advisorySentence,
  explanationVisible,
  initialWarmUpStage,
  minutesLine,
  unmetPrereqTitles,
  useOptimisticView,
  warmUpNote,
  WARM_UP_SKIP_NOTE,
  type WarmUpStage,
} from '@/ui/lesson';

export type LessonViewProps = {
  module: ModuleNode;
  entry: EntryDecision;
  saveNote: (text: string) => Promise<ApiResponse<Reflection>>;
  onRetryAuthoring: () => void;
  onRemove: () => void;
  /** Why there is no content, when there is none. See C9's ModuleDetail. */
  contentIssue: 'never-written' | 'damaged' | null;
  /** Rendered directly under the title, before the learning goals. */
  afterTitle?: ReactNode;
  /**
   * The "ask a question about this" panel, rendered with the lesson body once the learner
   * can see it. Passed in rather than built here so this component keeps making no
   * requests of its own.
   */
  askPanel?: ReactNode;
  /**
   * The pack of flash cards this lesson proposed, if it proposed one. Passed in for the
   * same reason `askPanel` is: this component makes no requests of its own.
   */
  cardPackPanel?: ReactNode;
  /** The learner's earlier go at the warm-up, if they have already had one. */
  warmUpRecord?: WarmUpRecord | null;
};

type LessonState = { acknowledged: boolean; warmUp: WarmUpStage };

export function LessonView({
  module,
  entry,
  saveNote,
  onRetryAuthoring,
  onRemove,
  contentIssue,
  afterTitle,
  askPanel,
  cardPackPanel,
  warmUpRecord = null,
}: LessonViewProps): ReactNode {
  const missing = unmetPrereqTitles(entry);
  const view = useOptimisticView<LessonState>({
    acknowledged: missing.length === 0,
    // WHY: a lesson the learner already had a go at reopens past the gate, showing what
    // they wrote and the explanation with it. Asking again would overwrite their first
    // answer with a second one written after they had read the lesson.
    warmUp: initialWarmUpStage(warmUpRecord),
  });

  const content = module.content;

  // WHY (optimistic UI): the acknowledgement, the attempt and the skip all change the page
  // on the click's own tick; the note is written behind them and only a failure moves the
  // page back — no control waits for the round trip.
  const acknowledge = (): void => {
    view.run<Reflection>({
      kind: 'save-reflection',
      apply: (state) => ({ ...state, acknowledged: true }),
      persist: () => saveNote(advisoryNote(missing)),
      reconcile: (state) => state,
    });
  };

  const attemptWarmUp = (text: string): void => {
    view.run<Reflection>({
      kind: 'save-reflection',
      apply: (state) => ({ ...state, warmUp: 'attempted' }),
      persist: () => saveNote(warmUpNote(text)),
      reconcile: (state) => state,
    });
  };

  const skipWarmUp = (): void => {
    view.run<Reflection>({
      kind: 'save-reflection',
      apply: (state) => ({ ...state, warmUp: 'skipped' }),
      persist: () => saveNote(WARM_UP_SKIP_NOTE),
      reconcile: (state) => state,
    });
  };

  if (content === null) {
    return (
      <>
        {contentIssue === 'never-written' ? (
          <NotWrittenCard title={module.title} topicId={module.topicId} onWriteNow={onRetryAuthoring} />
        ) : (
          <DegradedCard title={module.title} onRetryAuthoring={onRetryAuthoring} onDelete={onRemove} />
        )}
        {afterTitle}
      </>
    );
  }

  return (
    <article data-testid="lesson-view">
      <h1><MathText text={module.title} /></h1>
      <p className="la-muted">{minutesLine(module.estimatedMinutes)}</p>
      {/* WHY (F3): the questions are reachable from the lesson itself, so nobody has to go
          back to the subject to skip ahead. */}
      <p className="la-row">
        <a
          href={`/modules/${module.id}/eval`}
          className={module.testOutEligible ? undefined : 'la-muted'}
          data-testid="lesson-to-eval"
        >
          Go straight to the questions
        </a>
      </p>
      {afterTitle}

      <section className="la-card" data-testid="learning-goals">
        <h3>What you will be able to do</h3>
        <ul>
          {content.learningGoals.map((goal) => (
            <MathText as="li" key={goal} text={goal} />
          ))}
        </ul>
      </section>

      {view.state.acknowledged ? null : (
        <section className="la-warn" role="alert" data-testid="prereq-advisory">
          <h3>A heads-up before you start</h3>
          <p data-testid="prereq-advisory-text">{advisorySentence(missing)}</p>
          <button type="button" data-testid="acknowledge-advisory" onClick={acknowledge}>
            Got it — start anyway
          </button>
        </section>
      )}

      {view.state.acknowledged ? (
        <>
          <WarmUpGate
            warmUp={content.warmUp}
            stage={view.state.warmUp}
            savedAnswer={warmUpRecord?.stage === 'attempted' ? warmUpRecord.text : null}
            error={view.error}
            onAttempt={attemptWarmUp}
            onSkip={skipWarmUp}
          />
          {explanationVisible(view.state.warmUp) ? (
            <>
              <ExplanationView explanation={content.explanation} />
              {/* WHY (F3): the body of the lesson comes after the orientation the
                  explanation gives, and it is interleaved — prose, then something to look
                  at or do, then more prose. The single trailing visualization below is what
                  lessons written before that had instead, and it is still rendered so no
                  already-written lesson loses its picture. */}
              <LessonBlocks blocks={content.blocks} />
              <VisualizationView visualization={content.visualization} />
              {/* WHY here (F14): after the lesson, where the learner has just met the
                  names and can tell which of them they would want back in a week. Offered,
                  never added on their behalf. */}
              {cardPackPanel}
              {/* WHY here: after the lesson, where a question actually forms, and before the
                  two links out — so asking is the nearer thing to do than leaving. */}
              {askPanel}
              <p className="la-row">
                <a href={`/modules/${module.id}/eval`} data-testid="start-evaluation">
                  I&apos;m ready for the questions
                </a>
                <a href={`/topics/${module.topicId}`} data-testid="back-to-topic">
                  Back to the rest of the subject
                </a>
              </p>
            </>
          ) : null}
        </>
      ) : null}

      {view.error === null || view.state.acknowledged ? null : (
        <p className="la-error" role="alert" data-testid="lesson-error">
          {view.error}
        </p>
      )}
    </article>
  );
}
