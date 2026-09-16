// FRACTAL: covers F1, F5 | type unit
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  exampleAppError,
  exampleQueueEntry,
  exampleQueueView,
  isoDateStringSchema,
  type ApiResponse,
  type QueueEntry,
  type QueueView as QueueViewData,
} from '@/shapes';

const getQueue = vi.fn();

vi.mock('@/ui/api-client', () => ({
  getQueue: () => getQueue(),
}));

const { QueueView } = await import('@/ui/components/QueueView');
const { QUEUE_EMPTY, QUEUE_IDLE, ago, entryDetail, entryTitle, queueSummary } = await import('@/ui/queue-copy');

const NOW = new Date('2026-08-31T12:00:00.000Z');
const at = (iso: string): QueueEntry['queuedAt'] => isoDateStringSchema.parse(iso);

function ok(view: QueueViewData): ApiResponse<QueueViewData> {
  return { ok: true, data: view };
}

beforeEach(() => {
  getQueue.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('the words on the queue screen', () => {
  it('says what is happening in one sentence', () => {
    expect(queueSummary({ ...exampleQueueView, entries: [] })).toBe(QUEUE_EMPTY);
    expect(queueSummary({ waiting: 0, running: 0, entries: [exampleQueueEntry] })).toBe(QUEUE_IDLE);
    expect(queueSummary({ waiting: 0, running: 1, entries: [exampleQueueEntry] })).toBe('1 thing being written now.');
    expect(queueSummary({ waiting: 3, running: 0, entries: [exampleQueueEntry] })).toBe('3 things waiting to be written.');
    expect(queueSummary({ waiting: 2, running: 1, entries: [exampleQueueEntry] })).toBe(
      '1 thing being written now, 2 more waiting.',
    );
  });

  it('names work by what the learner would call it, never by its job kind', () => {
    expect(
      entryTitle({ ...exampleQueueEntry, kind: 'generate-topic', lessonTitle: null, plansOutline: true }),
    ).toBe('Planning the lessons for Information theory');
    // WHY the same job kind reads differently: a pass over a subject that already has its
    // plan is writing the lessons it names, and calling that "planning" made a background
    // pass look like the app re-planning a curriculum the learner can already see.
    expect(
      entryTitle({ ...exampleQueueEntry, kind: 'generate-topic', lessonTitle: null, plansOutline: false }),
    ).toBe('Writing more lessons for Information theory');
    expect(entryTitle(exampleQueueEntry)).toContain('Entropy as expected surprise');
    expect(entryTitle({ ...exampleQueueEntry, kind: 'detour' })).toContain('detour');
    // A lesson whose title we could not find is still described by its subject.
    expect(entryTitle({ ...exampleQueueEntry, lessonTitle: null })).toBe('Writing a lesson for Information theory');
  });

  it('answers "how long" rather than making the reader subtract two clock times', () => {
    expect(ago('2026-08-31T11:59:30.000Z', NOW)).toBe('just now');
    expect(ago('2026-08-31T11:58:00.000Z', NOW)).toBe('2 minutes ago');
    expect(ago('2026-08-31T11:00:00.000Z', NOW)).toBe('1 hour ago');
    expect(ago('2026-08-29T12:00:00.000Z', NOW)).toBe('2 days ago');
  });

  it('tells a waiting item from a running one, and mentions a second attempt', () => {
    const waiting: QueueEntry = {
      ...exampleQueueEntry,
      status: 'queued',
      startedAt: null,
      queuedAt: at('2026-08-31T11:50:00.000Z'),
    };
    expect(entryDetail(waiting, NOW)).toBe('waiting its turn · asked for 10 minutes ago');

    const retried: QueueEntry = {
      ...waiting,
      status: 'running',
      attempts: 2,
      startedAt: at('2026-08-31T11:55:00.000Z'),
    };
    expect(entryDetail(retried, NOW)).toBe('being written now · started 5 minutes ago · tried 2 times');
  });
});

describe('the queue screen', () => {
  it('shows every piece of work, with the failure sentence on the one that failed', async () => {
    const failed: QueueEntry = {
      ...exampleQueueEntry,
      id: 'j_failed',
      status: 'failed',
      lessonTitle: 'Codes and compression',
      finishedAt: at('2026-08-31T11:40:00.000Z'),
      errorMessage: exampleAppError.message,
    };
    getQueue.mockResolvedValue(ok({ waiting: 1, running: 1, entries: [exampleQueueEntry, failed] }));

    render(<QueueView pollMs={100_000} now={() => NOW} />);

    await waitFor(() => expect(screen.getAllByTestId('queue-entry')).toHaveLength(2));
    expect(screen.getByTestId('queue-summary').textContent).toBe('1 thing being written now, 1 more waiting.');
    expect(screen.getByTestId('queue-entry-error').textContent).toBe(exampleAppError.message);
  });

  it('says plainly when there is nothing to show', async () => {
    getQueue.mockResolvedValue(ok({ waiting: 0, running: 0, entries: [] }));
    render(<QueueView pollMs={100_000} now={() => NOW} />);

    await waitFor(() => expect(screen.getByTestId('queue-summary').textContent).toBe(QUEUE_EMPTY));
    expect(screen.queryAllByTestId('queue-entry')).toHaveLength(0);
  });

  // WHY: this screen answers "is anything happening", and an answer that quietly goes
  // stale is the wrong answer for as long as the screen is left open.
  it('keeps checking while it is open, and stops when it is closed', async () => {
    vi.useFakeTimers();
    try {
      getQueue.mockResolvedValue(ok({ waiting: 1, running: 0, entries: [exampleQueueEntry] }));
      const { unmount } = await act(async () => render(<QueueView pollMs={1_000} now={() => NOW} />));
      expect(getQueue).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
      expect(getQueue).toHaveBeenCalledTimes(3);

      unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(getQueue).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  // WHY the list survives: one dropped request is not evidence that the work stopped, and
  // blanking the screen every time a poll fails is worse than a list five seconds old.
  it('keeps the list it has when a check fails, and says so', async () => {
    getQueue.mockResolvedValueOnce(ok({ waiting: 0, running: 1, entries: [exampleQueueEntry] }));
    render(<QueueView pollMs={100_000} now={() => NOW} />);
    await waitFor(() => expect(screen.getAllByTestId('queue-entry')).toHaveLength(1));

    getQueue.mockResolvedValueOnce({ ok: false, error: exampleAppError } as ApiResponse<QueueViewData>);
    fireEvent.click(screen.getByTestId('queue-refresh'));

    await waitFor(() => expect(screen.getByTestId('queue-error')).toBeTruthy());
    expect(screen.getAllByTestId('queue-entry')).toHaveLength(1);
  });
});
