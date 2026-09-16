// FRACTAL: implements F3, F14 | component C10
'use client';
import Link from 'next/link';
import { use, useCallback, useEffect, useState, type ReactNode } from 'react';
import type { ModuleId } from '@/shapes';
import { moduleIdSchema } from '@/shapes';
import {
  addLessonCards,
  askLessonQuestion,
  deleteTopic,
  getModule,
  retryModule,
  saveReflection,
  type ModuleDetailView,
} from '@/ui/api-client';
import { fromResponse, LOADING, type LoadState } from '@/ui/load-state';
import { LoadStateBoundary } from '@/ui/components/LoadStateBoundary';
import { LessonView } from '@/ui/components/LessonView';
import { AskPanel } from '@/ui/components/AskPanel';
import { CardPackPanel } from '@/ui/components/CardPackPanel';
import { PredictionPrompt } from '@/ui/components/PredictionPrompt';
import { useStartWork } from '@/ui/lesson';

const BAD_LINK = 'That link does not point at a lesson we can open.';

export default function ModulePage({ params }: { params: Promise<{ id: string }> }): ReactNode {
  const raw = use(params).id;
  const parsed = moduleIdSchema.safeParse(raw);
  const moduleId: ModuleId | null = parsed.success ? parsed.data : null;

  const [state, setState] = useState<LoadState<ModuleDetailView>>(LOADING);
  const [message, setMessage] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const work = useStartWork();

  const load = useCallback((): void => {
    if (moduleId === null) {
      setState({ status: 'error', error: { code: 'validation', message: BAD_LINK, correlationId: 'c_browser' } });
      return;
    }
    setState(LOADING);
    void getModule(moduleId).then((response) => setState(fromResponse(response, () => false)));
  }, [moduleId]);

  useEffect(load, [load]);

  return (
    <>
      <LoadStateBoundary
        state={state}
        label="this lesson"
        emptyMessage="There is nothing in this lesson yet."
        onRetry={load}
      >
        {(view): ReactNode => (
          <>
            <p className="la-row">
              <Link href={`/topics/${view.module.topicId}`}>← Back to the subject</Link>
            </p>
            <LessonView
              module={view.module}
              /* WHY (F10 AC): one light question, asked under the title so the learner
                 knows what they are judging. It never gates the lesson below it and
                 skipping is a first-class answer. */
              afterTitle={<PredictionPrompt moduleId={view.module.id} existing={view.prediction} />}
              /* WHY (F3 AC): a question about the lesson is asked here, of the lesson,
                 without opening the graded conversation — and what was asked before comes
                 back with the page. */
              askPanel={
                <AskPanel
                  asked={view.questions}
                  ask={(question) => askLessonQuestion(view.module.id, question)}
                />
              }
              /* WHY (F14 x F2): a lesson may have written a handful of cards for the flat
                 facts in it. They are shown with the lesson and added only when asked. */
              cardPackPanel={
                view.module.content?.cardPack === undefined ? null : (
                  <CardPackPanel
                    pack={view.module.content.cardPack}
                    existingDeck={view.cardPackDeck}
                    add={() => addLessonCards(view.module.id)}
                  />
                )
              }
              warmUpRecord={view.warmUp}
              entry={view.entry}
              contentIssue={view.contentIssue}
              saveNote={(text) =>
                saveReflection({ topicId: view.module.topicId, moduleId: view.module.id, text })
              }
              onRetryAuthoring={() => {
                setMessage(null);
                work.run(() =>
                  retryModule(view.module.topicId, view.module.id).then((response) => {
                    setMessage(
                      response.ok
                        ? 'We are writing this lesson again. Come back in a moment and reload it.'
                        : response.error.message,
                    );
                  }),
                );
              }}
              onRemove={() => setRemoving(true)}
            />
            {removing ? (
              <section className="la-card" data-testid="remove-panel">
                <p>
                  Lessons can&apos;t be removed on their own yet — you can have this one written
                  again, or remove the whole subject.
                </p>
                <div className="la-row">
                  <button
                    type="button"
                    data-testid="remove-whole-topic"
                    onClick={() => {
                      void deleteTopic(view.module.topicId).then((response) => {
                        setRemoving(false);
                        setMessage(
                          response.ok
                            ? 'That subject has been removed. Head back home to pick another.'
                            : response.error.message,
                        );
                      });
                    }}
                  >
                    Remove the whole subject
                  </button>
                  <button type="button" data-testid="keep-topic" onClick={() => setRemoving(false)}>
                    Keep it for now
                  </button>
                </div>
              </section>
            ) : null}
          </>
        )}
      </LoadStateBoundary>

      {/* WHY (H2): starting the work is a round-trip of its own, and nothing on this page
          moved until it came back — a requested rewrite read as a click that did nothing. */}
      {work.awaiting ? (
        <p className="la-notice" role="status" data-testid="module-message">
          Starting that now…
        </p>
      ) : message === null && work.error === null ? null : (
        <p className="la-error" role="alert" data-testid="module-message">
          {message ?? work.error}
        </p>
      )}
    </>
  );
}
