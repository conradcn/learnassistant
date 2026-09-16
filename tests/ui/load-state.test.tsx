// FRACTAL: covers F5 | type unit
import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { ApiResponse, DashboardView } from '@/shapes';
import { exampleAppError, exampleDashboardView } from '@/shapes';
import { fromListResponse, fromResponse, type LoadState } from '@/ui/load-state';
import { LoadStateBoundary } from '@/ui/components/LoadStateBoundary';

function renderBoundary(state: LoadState<DashboardView>, onRetry: () => void = (): void => undefined) {
  return render(
    <LoadStateBoundary
      state={state}
      label="your subjects"
      emptyMessage="No subjects yet. Add one to get started."
      onRetry={onRetry}
    >
      {(view): ReactNode => <p data-testid="ready">{view.topics.length} subjects</p>}
    </LoadStateBoundary>,
  );
}

describe('LoadState', () => {
  it('renders loading, empty, error and ready as four distinct components', () => {
    renderBoundary({ status: 'loading' });
    expect(screen.getByTestId('load-loading')).toBeTruthy();
    expect(screen.queryByTestId('load-empty')).toBeNull();
    cleanup();

    renderBoundary({ status: 'empty' });
    expect(screen.getByTestId('load-empty').textContent).toContain('No subjects yet');
    expect(screen.queryByTestId('load-error')).toBeNull();
    cleanup();

    renderBoundary({ status: 'error', error: exampleAppError });
    expect(screen.getByTestId('load-error')).toBeTruthy();
    expect(screen.queryByTestId('load-empty')).toBeNull();
    cleanup();

    renderBoundary({ status: 'ready', data: exampleDashboardView });
    expect(screen.getByTestId('ready').textContent).toBe('1 subjects');
    expect(screen.queryByTestId('load-empty')).toBeNull();
    cleanup();
  });

  it('never shows the empty state for a failed load (H3)', () => {
    const failure: ApiResponse<DashboardView> = { ok: false, error: exampleAppError };
    const state = fromResponse<DashboardView>(failure, (view) => view.topics.length === 0);
    expect(state.status).toBe('error');

    renderBoundary(state);
    expect(screen.queryByTestId('load-empty')).toBeNull();
    expect(screen.getByTestId('load-error').textContent).toContain(exampleAppError.message);
    cleanup();
  });

  it('reaches the empty state only from a successful response', () => {
    const emptyOk: ApiResponse<DashboardView> = {
      ok: true,
      data: { topics: [], reviewsDue: 0, synthesisAvailable: false },
    };
    expect(fromResponse<DashboardView>(emptyOk, (view) => view.topics.length === 0).status).toBe('empty');
    expect(fromResponse({ ok: true, data: exampleDashboardView }, (v) => v.topics.length === 0).status).toBe('ready');
    expect(fromListResponse<number>({ ok: true, data: [] }).status).toBe('empty');
    expect(fromListResponse<number>({ ok: false, error: exampleAppError }).status).toBe('error');
  });

  it('offers a retry in place on a failure a second attempt could clear, and never on the empty state', () => {
    const onRetry = vi.fn();
    renderBoundary(
      { status: 'error', error: { ...exampleAppError, code: 'internal' } },
      onRetry,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    cleanup();

    renderBoundary({ status: 'empty' }, onRetry);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    cleanup();
  });

  // WHY (H13): a bad lesson link used to offer "Try again" as its only control — an action
  // that cannot succeed for something that does not exist — on a page with no other way out.
  it('withholds retry where it can never succeed, and always leaves a way home', () => {
    for (const code of ['not-found', 'validation'] as const) {
      renderBoundary({ status: 'error', error: { ...exampleAppError, code } });
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      expect(screen.getByTestId('load-error-home').getAttribute('href')).toBe('/');
      cleanup();
    }

    renderBoundary({ status: 'error', error: { ...exampleAppError, code: 'internal' } });
    expect(screen.getByRole('button', { name: 'Try again' })).not.toBeNull();
    expect(screen.getByTestId('load-error-home').getAttribute('href')).toBe('/');
    cleanup();
  });

  it('states the problem in the learner’s words, with no status code or stack', () => {
    renderBoundary({
      status: 'error',
      error: { code: 'store-corrupt', message: 'Your learning data could not be opened.', correlationId: 'c_18ab' },
    });
    const text = screen.getByTestId('load-error').textContent ?? '';
    expect(text).toContain('Your learning data could not be opened.');
    expect(text).not.toContain('store-corrupt');
    expect(text).not.toContain('c_18ab');
    expect(text).not.toMatch(/\b(500|503|error code)\b/i);
    cleanup();
  });
});
