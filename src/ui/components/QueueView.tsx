// FRACTAL: implements F1, F5 | component C10
'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { QueueView as QueueViewData } from '@/shapes';
import { getQueue } from '@/ui/api-client';
import {
  QUEUE_INTRO,
  QUEUE_REFRESH_LABEL,
  QUEUE_TITLE,
  QUEUE_UNAVAILABLE,
  entryDetail,
  entryTitle,
  queueSummary,
} from '@/ui/queue-copy';

/**
 * How often the list refreshes itself while the screen is open.
 *
 * WHY it polls at all: this screen exists to answer "is anything happening", and a
 * snapshot that silently goes stale answers it wrongly for as long as it is left open —
 * a learner watching a lesson being written would see it frozen mid-write forever. WHY
 * five seconds rather than the SSE stream the topic page uses: that stream carries one
 * subject's generation progress, and this list is every subject and every state, including
 * the rows that were already finished before the page opened.
 */
export const QUEUE_POLL_MS = 5_000;

export type QueueViewProps = {
  /** Injected in tests so the poll interval and the clock do not have to be real. */
  pollMs?: number;
  now?: () => Date;
};

export function QueueView({ pollMs = QUEUE_POLL_MS, now = () => new Date() }: QueueViewProps): ReactNode {
  const [view, setView] = useState<QueueViewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // WHY a ref and not state: a refresh landing after the learner has navigated away must
  // not set state on a screen that is gone, and the poll must not be restarted every time
  // an answer arrives.
  const live = useRef(true);

  const refresh = useCallback((): void => {
    void getQueue().then((response) => {
      if (!live.current) return;
      setLoading(false);
      if (!response.ok) {
        // WHY the old list is kept: one failed poll is not evidence that the work stopped,
        // and blanking the screen every time a request is dropped is worse than a list
        // that is five seconds old.
        setError(response.error.message.length > 0 ? response.error.message : QUEUE_UNAVAILABLE);
        return;
      }
      setError(null);
      setView(response.data);
    });
  }, []);

  useEffect(() => {
    live.current = true;
    refresh();
    const timer = setInterval(refresh, pollMs);
    return () => {
      live.current = false;
      clearInterval(timer);
    };
  }, [refresh, pollMs]);

  return (
    <section className="la-card" data-testid="queue-view">
      <h2>{QUEUE_TITLE}</h2>
      <p className="la-muted">{QUEUE_INTRO}</p>
      {error === null ? null : (
        <p className="la-error" role="alert" data-testid="queue-error">
          {error}
        </p>
      )}
      {view === null ? (
        <p className="la-muted" data-testid="queue-summary">
          {loading ? 'Looking…' : QUEUE_UNAVAILABLE}
        </p>
      ) : (
        <>
          <p className="la-count" data-testid="queue-summary">
            {queueSummary(view)}
          </p>
          <ul className="la-list" data-testid="queue-list">
            {view.entries.map((entry) => (
              <li key={entry.id} data-testid="queue-entry" data-status={entry.status}>
                <p>{entryTitle(entry)}</p>
                <p className="la-muted" data-testid="queue-entry-detail">
                  {entryDetail(entry, now())}
                </p>
                {entry.errorMessage === null ? null : (
                  <p className="la-error" data-testid="queue-entry-error">
                    {entry.errorMessage}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="la-row">
        <button type="button" data-testid="queue-refresh" onClick={refresh}>
          {QUEUE_REFRESH_LABEL}
        </button>
      </div>
    </section>
  );
}
