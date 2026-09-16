// FRACTAL: implements F5, F7, F9 | component C10
'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { DashboardTopic, DashboardView, TopicStatus } from '@/shapes';
import { getDashboard } from '@/ui/api-client';
import { fromResponse, LOADING, type LoadState } from '@/ui/load-state';
import { LoadStateBoundary } from '@/ui/components/LoadStateBoundary';
import { MathText } from '@/ui/components/MathText';
import { setDashboard, useAppStore } from '@/ui/store';
import { capstoneLine, progressLine } from '@/ui/copy';

const STORE_DOWN_CODES: readonly string[] = ['store-corrupt', 'store-schema-ahead'];

const STATUS_TEXT: Record<TopicStatus, string> = {
  queued: 'Planning soon',
  generating: 'Writing now',
  ready: 'Ready',
  'ready-with-notes': 'Ready · a few notes',
  'needs-attention': 'Needs a look',
  'modules-complete': 'Project left',
  done: 'Finished',
};


function TopicCard({ topic }: { topic: DashboardTopic }): ReactNode {
  // WHY: the counts were already on the card, but as a run of numbers you have to read and
  // add up before you know whether a subject is barely started or nearly finished. The bar
  // is the same three numbers, answered at a glance. It never replaces the words below it —
  // a proportion drawn in colour alone is not an accessible readout (WCAG 1.4.1), so the
  // counts stay and the bar is marked decorative.
  const total = topic.completedCount + topic.availableCount + topic.remainingCount;
  const percent = total === 0 ? 0 : Math.round((topic.completedCount / total) * 100);
  return (
    <li className="la-card" data-testid="dashboard-topic">
      <h2>
        <Link href={`/topics/${topic.id}`}>
          <MathText text={topic.subject} />
        </Link>
        <span className="la-badge">{STATUS_TEXT[topic.status]}</span>
      </h2>
      {total === 0 ? null : (
        <div className="la-progress" aria-hidden="true" data-testid="progress-bar">
          <span style={{ width: `${percent}%` }} />
        </div>
      )}
      <p className="la-meta" data-testid="progress-line">{progressLine(topic)}</p>
      <p className="la-muted">{capstoneLine(topic)}</p>
    </li>
  );
}

export default function DashboardPage(): ReactNode {
  const [state, setState] = useState<LoadState<DashboardView>>(LOADING);
  const store = useAppStore();

  const load = useCallback((): void => {
    setState(LOADING);
    void getDashboard().then((response) => {
      const next = fromResponse(response, (view) => view.topics.length === 0);
      setState(next);
      setDashboard(response.ok ? response.data : null);
    });
  }, []);

  useEffect(load, [load]);

  if (state.status === 'error' && STORE_DOWN_CODES.includes(state.error.code)) {
    return (
      <section className="la-card" role="alert" data-testid="store-down">
        <h1>We couldn&apos;t open your saved learning</h1>
        <p>{state.error.message}</p>
        <p>
          <Link href="/recover">Go to the repair page</Link>
        </p>
      </section>
    );
  }

  return (
    <>
      {/* WHY: adding a subject is the only way in, so it shares the title's line rather
          than sitting in a paragraph of its own below the status readouts. */}
      <div className="la-page-head">
        <h1>What you&apos;re learning</h1>
        <Link href="/topics/new" className="la-primary la-btn-link">
          Add a subject
        </Link>
      </div>
      <p className="la-row">
        <Link href="/review">{store.dashboard?.reviewsDue ?? 0} ready to review</Link>
        {store.dashboard?.synthesisAvailable === true ? (
          <Link href="/synthesis">Link two subjects</Link>
        ) : null}
      </p>
      <LoadStateBoundary
        state={state}
        label="your subjects"
        emptyMessage="No subjects yet. Add one to get started."
        onRetry={load}
      >
        {(view): ReactNode => (
          <ul className="la-list" data-testid="dashboard-list">
            {view.topics.map((topic) => (
              <TopicCard key={topic.id} topic={topic} />
            ))}
          </ul>
        )}
      </LoadStateBoundary>
    </>
  );
}
