// FRACTAL: implements F5 | component C10
'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { LoadState } from '@/ui/shapes';

/**
 * Codes for which retrying can never succeed: the thing being asked for is not there, or
 * the link that asked for it was malformed. Retry is offered for everything else, because
 * those are the failures a second attempt can actually clear.
 */
const UNRETRYABLE = new Set(['not-found', 'validation']);

export type LoadStateBoundaryProps<T> = {
  state: LoadState<T>;
  label: string;
  emptyMessage: string;
  onRetry: () => void;
  children: (data: T) => ReactNode;
};

export function LoadingPanel({ label }: { label: string }): ReactNode {
  return (
    <p className="la-muted" data-testid="load-loading" role="status">
      Loading {label}…
    </p>
  );
}

export function EmptyPanel({ message }: { message: string }): ReactNode {
  return (
    <p className="la-empty" data-testid="load-empty">
      {message}
    </p>
  );
}

/**
 * WHY (H13): a bad lesson link used to land on this panel with "Try again" as the only
 * control — an action that can never succeed for something that does not exist, on a page
 * with no other way out. The way home is always offered, and retry is only offered when a
 * second attempt could actually change the answer.
 */
export function ErrorPanel({
  message,
  onRetry,
  code,
}: {
  message: string;
  onRetry: () => void;
  code?: string;
}): ReactNode {
  return (
    <div className="la-error" data-testid="load-error" role="alert">
      <p>{message}</p>
      <div className="la-row">
        {code !== undefined && UNRETRYABLE.has(code) ? null : (
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        )}
        <Link href="/" data-testid="load-error-home">
          Back to everything you are learning
        </Link>
      </div>
    </div>
  );
}

/**
 * WHY (H3): empty and failed are two different components here and neither can be
 * reached from the other's branch, so a failed load can never be shown as "nothing yet".
 */
export function LoadStateBoundary<T>({
  state,
  label,
  emptyMessage,
  onRetry,
  children,
}: LoadStateBoundaryProps<T>): ReactNode {
  if (state.status === 'loading') return <LoadingPanel label={label} />;
  if (state.status === 'error') {
    return <ErrorPanel message={state.error.message} onRetry={onRetry} code={state.error.code} />;
  }
  if (state.status === 'empty') return <EmptyPanel message={emptyMessage} />;
  return <>{children(state.data)}</>;
}
