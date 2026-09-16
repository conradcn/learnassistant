// FRACTAL: covers F7 | type unit
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApiResponse, ReviewCue } from '@/shapes';
import {
  exampleAppError,
  exampleHealthView,
  exampleModuleNode,
  exampleReviewCue,
  moduleIdSchema,
} from '@/shapes';

const getReviewsDue = vi.fn();
const getDashboard = vi.fn();
const getModule = vi.fn();
const recordReview = vi.fn();
const getHealth = vi.fn();

vi.mock('@/ui/api-client', () => ({
  getReviewsDue: () => getReviewsDue(),
  getDashboard: () => getDashboard(),
  getModule: (id: string) => getModule(id),
  recordReview: (id: string, correct: boolean) => recordReview(id, correct),
  getHealth: () => getHealth(),
}));

const ReviewPage = (await import('../../app/review/page')).default;
const { ReviewQueue } = await import('@/ui/components/ReviewQueue');
const { queueHeader, toCard, REVIEW_EMPTY_MESSAGE } = await import('@/ui/review-copy');

const secondId = moduleIdSchema.parse('m_1111111111111111');

// The queue page consumes `ReviewCue`, not `ReviewItem`: the memory model never crosses
// the API boundary. See `docs/spaced-repetition.md` §5.
const items: ReviewCue[] = [
  exampleReviewCue,
  { ...exampleReviewCue, moduleId: secondId, needsAnotherLook: true },
];

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  getHealth.mockResolvedValue({ ok: true, data: exampleHealthView });
  getReviewsDue.mockResolvedValue({ ok: true, data: items });
  getDashboard.mockResolvedValue({ ok: true, data: { topics: [], reviewsDue: 7, synthesisAvailable: false } });
  getModule.mockImplementation((id: string) =>
    Promise.resolve({ ok: true, data: { module: { ...exampleModuleNode, id, title: `Lesson ${id}` }, entry: null } }),
  );
  recordReview.mockResolvedValue({ ok: true, data: exampleReviewCue });
});

afterEach(cleanup);

describe('the due queue', () => {
  it('is a list of optional cards, not a blocking dialog', async () => {
    render(<ReviewPage />);
    await waitFor(() => expect(screen.getByTestId('review-list')).toBeTruthy());
    expect(screen.getAllByTestId('review-card').length).toBe(2);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to your subjects' })).toBeTruthy();
  });

  it('says how much of the backlog is showing when it exceeds the daily cap', () => {
    const cards = items.map((item) => toCard(item, 'A lesson'));
    render(<ReviewQueue cards={cards} dueTotal={7} />);
    expect(screen.getByTestId('review-header').textContent).toBe("7 due, showing today's 2");
    cleanup();
    render(<ReviewQueue cards={cards} dueTotal={2} />);
    expect(screen.getByTestId('review-header').textContent).toBe('2 due today');
  });

  it('computes the header from the backlog and the shown count', () => {
    expect(queueHeader(50, 15)).toBe("50 due, showing today's 15");
    expect(queueHeader(1, 1)).toBe('1 due today');
  });

  it('records an outcome optimistically and never disables the control', async () => {
    const gate = deferred<ApiResponse<ReviewCue>>();
    recordReview.mockReturnValue(gate.promise);
    const cards = items.map((item) => toCard(item, 'A lesson'));
    render(<ReviewQueue cards={cards} dueTotal={2} />);

    const button = screen.getByTestId(`review-remembered-${exampleReviewCue.moduleId}`);
    fireEvent.click(button);
    expect(screen.getByTestId(`review-outcome-${exampleReviewCue.moduleId}`).textContent).toContain('later on');
    expect((button as HTMLButtonElement).disabled).toBe(false);

    gate.resolve({ ok: true, data: exampleReviewCue });
    await waitFor(() =>
      expect(screen.getByTestId(`review-outcome-${exampleReviewCue.moduleId}`)).toBeTruthy(),
    );
  });

  it('rolls the outcome back and surfaces the reason when the write fails', async () => {
    recordReview.mockResolvedValue({ ok: false, error: exampleAppError });
    const cards = items.map((item) => toCard(item, 'A lesson'));
    render(<ReviewQueue cards={cards} dueTotal={2} />);

    fireEvent.click(screen.getByTestId(`review-missed-${secondId}`));
    expect(screen.getByTestId(`review-outcome-${secondId}`).textContent).toContain('sooner');

    await waitFor(() => expect(screen.getByTestId('review-error').textContent).toBe(exampleAppError.message));
    expect(screen.queryByTestId(`review-outcome-${secondId}`)).toBeNull();
  });

  it('shows nothing-due and could-not-load as different states', async () => {
    getReviewsDue.mockResolvedValue({ ok: true, data: [] });
    render(<ReviewPage />);
    await waitFor(() => expect(screen.getByTestId('load-empty').textContent).toBe(REVIEW_EMPTY_MESSAGE));
    expect(screen.queryByTestId('load-error')).toBeNull();
    cleanup();

    getReviewsDue.mockResolvedValue({ ok: false, error: exampleAppError });
    render(<ReviewPage />);
    await waitFor(() => expect(screen.getByTestId('load-error')).toBeTruthy());
    expect(screen.queryByTestId('load-empty')).toBeNull();
  });
});
