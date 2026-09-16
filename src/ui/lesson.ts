// FRACTAL: implements F3, F4, F12, F13 | component C10
'use client';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { EntryDecision, Visualization, WarmUpRecord } from '@/shapes';
import { isSafeVideoUrl } from '@/ui/sanitize';
import { runOptimisticOp, type OpHandle, type OptimisticHost, type OptimisticOp } from '@/ui/optimistic';
import { addPending, removePending } from '@/ui/store';

export type WarmUpStage = 'not-attempted' | 'attempted' | 'skipped';

/** F3 AC: nothing of the explanation exists until the learner has had their first go. */
export function explanationVisible(stage: WarmUpStage): boolean {
  return stage !== 'not-attempted';
}

export function hasVisualization(visualization: Visualization): boolean {
  return visualization.kind !== 'none';
}

export type VideoLink =
  | { safe: true; href: string; target: '_blank'; rel: 'noopener noreferrer' }
  | { safe: false; reason: string };

/** Defence in depth: the host is checked again here, at the moment the link is drawn. */
export function videoLink(url: string): VideoLink {
  if (!isSafeVideoUrl(url)) {
    return {
      safe: false,
      reason: 'This lesson points at a video we do not recognise, so we have not made it clickable.',
    };
  }
  return { safe: true, href: url, target: '_blank', rel: 'noopener noreferrer' };
}

export function unmetPrereqTitles(entry: EntryDecision): string[] {
  return entry.advisory === null ? [] : entry.advisory.unmetPrereqs.map((p) => p.title);
}

export function advisorySentence(titles: string[]): string {
  if (titles.length === 1) return `Most people do ${titles[0]} first. You can still start here.`;
  return `Most people do ${titles.join(' and ')} first. You can still start here.`;
}

export function advisoryNote(titles: string[]): string {
  return `Started this lesson before finishing ${titles.join(' and ')}.`;
}

// The note format and the skip marker live with the reader that parses them back out, so
// the writing side and the reading side cannot drift apart.
export { warmUpNote, WARM_UP_SKIP_NOTE } from '@/reflect/warm-up';

/** Where the warm-up starts on a fresh render: the learner's earlier go, if they had one. */
export function initialWarmUpStage(record: WarmUpRecord | null): WarmUpStage {
  return record === null ? 'not-attempted' : record.stage;
}

export function minutesLine(minutes: number): string {
  if (minutes <= 1) return 'About a minute.';
  return `About ${Math.round(minutes)} minutes.`;
}

export type OptimisticView<S> = {
  state: S;
  error: string | null;
  run: <R>(op: OptimisticOp<S, R>) => OpHandle;
  set: (next: S) => void;
  update: (change: (current: S) => S) => void;
  clearError: () => void;
};

/**
 * One optimistic runner for a component-local view: `run` applies on the calling tick and
 * the shared runner does the reconcile-or-roll-back, so no page grows its own copy.
 */
export function useOptimisticView<S>(initial: S): OptimisticView<S> {
  const [state, setState] = useState<S>(initial);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<S>(initial);

  const host = useMemo<OptimisticHost<S>>(
    () => ({
      getState: () => latest.current,
      setState: (next: S): void => {
        latest.current = next;
        setState(next);
      },
      addPending,
      removePending,
      setError: (next): void => setError(next === null ? null : next.message),
    }),
    [],
  );

  const run = useCallback(
    <R,>(op: OptimisticOp<S, R>): OpHandle => runOptimisticOp(host, op),
    [host],
  );

  const set = useCallback(
    (next: S): void => {
      latest.current = next;
      setState(next);
    },
    [],
  );

  const update = useCallback((change: (current: S) => S): void => {
    const next = change(latest.current);
    latest.current = next;
    setState(next);
  }, []);

  return { state, error, run, set, update, clearError: () => setError(null) };
}

export type StartedWork = {
  /**
   * True from the instant the learner asks for the work until the work has settled.
   * WHY: pressing the button is not the same event as the work starting, and a consumer
   * that only sets its own pending flag once the request resolves re-renders its untouched
   * invitation for the whole round-trip in between — so the press looks like it never
   * landed and the button is live and re-clickable. Consumers OR this into their pending
   * state.
   */
  awaiting: boolean;
  error: string | null;
  run: (work: () => void | Promise<unknown>) => void;
  cancel: () => void;
};

/**
 * Runs one thing the learner asked for and tracks the wait.
 *
 * WHY there is nothing in front of it: this is a single-user local app, and the control
 * the learner pressed already names what it will do. Pressing it IS the authorisation —
 * there is no preview to acknowledge, no token to redeem and no dialog restating the
 * button. All this hook owns is the window between the click and the answer.
 */
export function useStartWork(): StartedWork {
  const [awaiting, setAwaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);

  const run = useCallback((work: () => void | Promise<unknown>): void => {
    setError(null);
    live.current = true;
    setAwaiting(true);
    void (async () => {
      try {
        await work();
      } catch {
        // WHY it is shown rather than rethrown: the work was already asked for and may well
        // have started. A throw here is the caller's own promise breaking, and rethrowing it
        // only produces an unhandled rejection nobody sees.
        if (live.current) {
          setError(
            'Something went wrong after that started. That work may already be under way — reload the page before trying again.',
          );
        }
      } finally {
        if (live.current) setAwaiting(false);
      }
    })();
  }, []);

  /** Abandons whatever is in flight for display purposes; the work itself still runs. */
  const cancel = useCallback((): void => {
    live.current = false;
    setAwaiting(false);
    setError(null);
  }, []);

  return { awaiting, error, run, cancel };
}
