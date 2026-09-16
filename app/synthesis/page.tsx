// FRACTAL: implements F9 | component C10
'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { DashboardTopic, EvalSession } from '@/shapes';
import { getDashboard, openEvaluation } from '@/ui/api-client';
import { LOADING, ready, type LoadState } from '@/ui/load-state';
import { LoadStateBoundary } from '@/ui/components/LoadStateBoundary';
import { MathText } from '@/ui/components/MathText';
import {
  SYNTHESIS_INTRO,
  SYNTHESIS_START,
  SYNTHESIS_UNAVAILABLE,
  synthesisCandidates,
  synthesisQuestionLine,
  synthesisReady,
} from '@/ui/practice-copy';

export default function SynthesisPage(): ReactNode {
  const [state, setState] = useState<LoadState<DashboardTopic[]>>(LOADING);
  const [first, setFirst] = useState<string>('');
  const [second, setSecond] = useState<string>('');
  const [opened, setOpened] = useState<EvalSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  // WHY (H3): opening the conversation is a Claude CLI session that can take tens of
  // seconds, and nothing on this screen changed while it ran — the learner could not tell
  // the click had landed, and each further click dispatched another session.
  const [starting, setStarting] = useState(false);

  const load = useCallback((): void => {
    setState(LOADING);
    void getDashboard().then((response) => {
      if (!response.ok) {
        setState({ status: 'error', error: response.error });
        return;
      }
      const candidates = synthesisCandidates(response.data.topics);
      if (!synthesisReady(candidates)) {
        setState({ status: 'empty' });
        return;
      }
      setFirst(candidates[0].id);
      setSecond(candidates[1].id);
      setState(ready(candidates));
    });
  }, []);

  useEffect(load, [load]);

  const start = (topics: readonly DashboardTopic[]): void => {
    const a = topics.find((topic) => topic.id === first);
    const b = topics.find((topic) => topic.id === second);
    if (a === undefined || b === undefined || a.id === b.id) {
      setError('Pick two different subjects to link together.');
      return;
    }
    setError(null);
    setStarting(true);
    void openEvaluation({ kind: 'synthesis', topicA: a.id, topicB: b.id }).then(
      (response) => {
        // Cleared on failure too, so a refusal leaves a screen that can be tried again.
        setStarting(false);
        if (response.ok) setOpened(response.data);
        else setError(response.error.message);
      },
    );
  };

  return (
    <>
      <h1>Link two subjects</h1>
      <p className="la-row">
        <Link href="/">Back to your subjects</Link>
      </p>
      <p className="la-muted">{SYNTHESIS_INTRO}</p>
      <LoadStateBoundary
        state={state}
        label="subjects you could link"
        emptyMessage={SYNTHESIS_UNAVAILABLE}
        onRetry={load}
      >
        {(topics): ReactNode => (
          <section className="la-card" data-testid="synthesis-picker">
            <div className="la-row">
              <div className="la-field">
                <label htmlFor="synthesis-first">First subject</label>
                <select
                  id="synthesis-first"
                  value={first}
                  data-testid="synthesis-first"
                  onChange={(event): void => {
                    const picked = event.target.value;
                    setFirst(picked);
                    // WHY: the second list drops whatever the first holds, so a clash has to
                    // move the second pick rather than leave it on a choice no longer offered.
                    if (picked === second) {
                      setSecond(topics.find((topic) => topic.id !== picked)?.id ?? second);
                    }
                  }}
                >
                  {topics.map((topic) => (
                    <option key={topic.id} value={topic.id}>
                      {topic.subject}
                    </option>
                  ))}
                </select>
              </div>
              <div className="la-field">
                <label htmlFor="synthesis-second">Second subject</label>
                <select
                  id="synthesis-second"
                  value={second}
                  data-testid="synthesis-second"
                  onChange={(event): void => setSecond(event.target.value)}
                >
                  {/* WHY: the same subject twice is not a link, so it cannot be picked here. */}
                  {topics
                    .filter((topic) => topic.id !== first)
                    .map((topic) => (
                      <option key={topic.id} value={topic.id}>
                        {topic.subject}
                      </option>
                    ))}
                </select>
              </div>
            </div>
            <p data-testid="synthesis-preview" style={{ fontSize: 16, marginTop: 12 }}>
              {synthesisQuestionLine(
                topics.find((topic) => topic.id === first)?.subject ?? '',
                topics.find((topic) => topic.id === second)?.subject ?? '',
              )}
            </p>
            <div className="la-row">
              <button
                type="button"
                className="la-primary"
                data-testid="synthesis-start"
                disabled={first === second || starting}
                onClick={(): void => start(topics)}
              >
                {SYNTHESIS_START}
              </button>
              {starting ? (
                <p className="la-muted" role="status" data-testid="synthesis-starting">
                  Getting your question ready. This takes a few seconds.
                </p>
              ) : null}
            </div>
            {error === null ? null : (
              <p className="la-error" role="alert" data-testid="synthesis-error">
                {error}
              </p>
            )}
            {opened === null ? null : (
              <div data-testid="synthesis-opened">
                <MathText
                  as="p"
                  text={
                    opened.turns.find((turn) => turn.role === 'evaluator')?.text ??
                    'Your question is ready.'
                  }
                />
                <Link href={`/modules/${opened.moduleId}/eval`}>Go to the conversation</Link>
              </div>
            )}
          </section>
        )}
      </LoadStateBoundary>
    </>
  );
}
