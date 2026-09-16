// FRACTAL: implements F8 | component C10
'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { PracticeSession } from '@/shapes';
import { getDashboard, startPractice } from '@/ui/api-client';
import { LOADING, type LoadState } from '@/ui/load-state';
import { LoadStateBoundary } from '@/ui/components/LoadStateBoundary';
import { PracticeRunner } from '@/ui/components/PracticeRunner';
import { PRACTICE_EMPTY_MESSAGE, practiceState, PRACTICE_SIZE } from '@/ui/practice-copy';

export default function PracticePage(): ReactNode {
  const [state, setState] = useState<LoadState<PracticeSession>>(LOADING);
  // WHY (F8 AC): the questions carry only which subject they came from, so the names the
  // learner recognises have to be looked up alongside the run.
  const [subjects, setSubjects] = useState<Record<string, string>>({});

  const load = useCallback((): void => {
    setState(LOADING);
    void startPractice(PRACTICE_SIZE).then((response) => setState(practiceState(response)));
    void getDashboard().then((response) => {
      if (!response.ok) return;
      setSubjects(Object.fromEntries(response.data.topics.map((topic) => [topic.id, topic.subject])));
    });
  }, []);

  useEffect(load, [load]);

  return (
    <>
      <h1>Mixed practice</h1>
      <p className="la-row">
        <Link href="/">Back to your subjects</Link>
        <Link href="/review">Lessons worth revisiting</Link>
      </p>
      <LoadStateBoundary
        state={state}
        label="your practice questions"
        emptyMessage={PRACTICE_EMPTY_MESSAGE}
        onRetry={load}
      >
        {(session): ReactNode => (
          <PracticeRunner key={session.id} session={session} subjects={subjects} />
        )}
      </LoadStateBoundary>
    </>
  );
}
