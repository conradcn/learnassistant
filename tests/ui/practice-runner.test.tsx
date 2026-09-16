// FRACTAL: covers F8, F9 | type unit
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApiResponse, DashboardView, PracticeSession } from '@/shapes';
import {
  exampleAppError,
  exampleDashboardTopic,
  exampleEvalSession,
  exampleHealthView,
  examplePracticeQuestion,
  examplePracticeSession,
  sessionIdSchema,
  topicIdSchema,
} from '@/shapes';

const startPractice = vi.fn();
const answerPractice = vi.fn();
const getDashboard = vi.fn();
const openEvaluation = vi.fn();
const getHealth = vi.fn();

vi.mock('@/ui/api-client', () => ({
  startPractice: (size: number) => startPractice(size),
  answerPractice: (id: string, index: number, correct: boolean) => answerPractice(id, index, correct),
  getDashboard: () => getDashboard(),
  getHealth: () => getHealth(),
  openEvaluation: (target: unknown) => openEvaluation(target),
}));

const PracticePage = (await import('../../app/practice/page')).default;
const SynthesisPage = (await import('../../app/synthesis/page')).default;
const { PracticeRunner } = await import('@/ui/components/PracticeRunner');
const { practiceState, PRACTICE_EMPTY_MESSAGE, SYNTHESIS_UNAVAILABLE, synthesisReady } = await import(
  '@/ui/practice-copy'
);

const session: PracticeSession = {
  ...examplePracticeSession,
  id: sessionIdSchema.parse('s_0d9fQ2xK4mZa71bC'),
  questions: [
    { ...examplePracticeQuestion, text: 'First question' },
    { ...examplePracticeQuestion, text: 'Second question', topicId: topicIdSchema.parse('t_1111111111111111') },
    { ...examplePracticeQuestion, text: 'Third question' },
  ],
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const twoSubjects: DashboardView = {
  topics: [
    exampleDashboardTopic,
    { ...exampleDashboardTopic, id: topicIdSchema.parse('t_1111111111111111'), subject: 'Information theory' },
  ],
  reviewsDue: 0,
  synthesisAvailable: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  startPractice.mockResolvedValue({ ok: true, data: session });
  answerPractice.mockImplementation((_id: string, index: number, correct: boolean) =>
    Promise.resolve({
      ok: true,
      data: {
        ...session,
        questions: session.questions.map((q, i) => (i <= index ? { ...q, answered: true, correct } : q)),
        answeredCount: index + 1,
      },
    }),
  );
  getDashboard.mockResolvedValue({ ok: true, data: twoSubjects });
  openEvaluation.mockResolvedValue({ ok: true, data: exampleEvalSession });
  getHealth.mockResolvedValue({ ok: true, data: exampleHealthView });
});

afterEach(cleanup);

describe('the practice run', () => {
  it('mixes questions from more than one subject', async () => {
    render(<PracticePage />);
    await waitFor(() => expect(screen.getByTestId('practice-runner')).toBeTruthy());
    const subjects = new Set(session.questions.map((q) => q.topicId));
    expect(subjects.size).toBeGreaterThan(1);
    expect(screen.getByTestId('practice-question').textContent).toContain('First question');
  });

  it('marks an answer on the same tick and keeps the buttons live', async () => {
    const gate = deferred<ApiResponse<PracticeSession>>();
    answerPractice.mockReturnValue(gate.promise);
    render(<PracticeRunner session={session} />);

    const button = screen.getByTestId('practice-got-it');
    fireEvent.click(button);
    expect(screen.getByTestId('practice-question').textContent).toContain('Second question');
    expect(screen.getByTestId('practice-progress').textContent).toBe('1 answered, 2 to go');
    expect((screen.getByTestId('practice-got-it') as HTMLButtonElement).disabled).toBe(false);
    gate.resolve({ ok: true, data: { ...session, answeredCount: 1 } });
    await waitFor(() => expect(screen.getByTestId('practice-progress')).toBeTruthy());
  });

  /**
   * WHY (WCAG SC 4.1.3): the rating buttons outlive the question swap, so focus is never
   * moved and a screen reader re-reads nothing on its own. The only thing that speaks is
   * a live region whose text changed, so what is asserted is that it is polite, that it
   * changed, and that what it now says confirms both halves — the rating landed, and a
   * new question is up.
   */
  it('announces the rating and the new question in a polite live region', async () => {
    const gate = deferred<ApiResponse<PracticeSession>>();
    answerPractice.mockReturnValue(gate.promise);
    render(<PracticeRunner session={session} />);

    const region = screen.getByTestId('practice-announcement');
    expect(region.getAttribute('role')).toBe('status');
    // Present and silent before the first rating: a region inserted alongside its own
    // text is announced by no screen reader reliably.
    expect(region.textContent).toBe('');

    fireEvent.click(screen.getByTestId('practice-got-it'));
    // Spoken on the same tick as the press, not after the write settles.
    expect(region.textContent).toBe('I remembered this. 1 answered, 2 to go. Next question.');
    expect(region.className).toContain('la-visually-hidden');

    gate.resolve({
      ok: true,
      data: {
        ...session,
        questions: session.questions.map((q, i) => (i === 0 ? { ...q, answered: true, correct: true } : q)),
        answeredCount: 1,
      },
    });
    await waitFor(() => expect(screen.getByTestId('practice-question').textContent).toContain('Second'));

    // The count is what makes the next announcement differ from this one, which is what
    // makes it get read at all.
    fireEvent.click(screen.getByTestId('practice-missed'));
    expect(screen.getByTestId('practice-announcement').textContent).toBe(
      'I had forgotten this. 2 answered, 1 to go. Next question.',
    );

    // Exactly one live region, so the tally is not read out twice per rating.
    expect(document.querySelectorAll('[role="status"], [aria-live]').length).toBe(1);
  });

  it('rolls a failed answer back and says why', async () => {
    answerPractice.mockResolvedValue({ ok: false, error: exampleAppError });
    render(<PracticeRunner session={session} />);
    fireEvent.click(screen.getByTestId('practice-missed'));
    expect(screen.getByTestId('practice-question').textContent).toContain('Second question');

    await waitFor(() => expect(screen.getByTestId('practice-error').textContent).toBe(exampleAppError.message));
    expect(screen.getByTestId('practice-question').textContent).toContain('First question');
    expect(screen.getByTestId('practice-progress').textContent).toBe('0 answered, 3 to go');
  });

  // WHY (F8): skipping is not the same answer as forgetting. It sets the question aside
  // for this run and records nothing, so the progress count must not move.
  it('skips a question without stalling the run and without recording a miss', async () => {
    render(<PracticeRunner session={session} />);
    fireEvent.click(screen.getByTestId('practice-skip'));
    expect(screen.getByTestId('practice-question').textContent).toContain('Second question');
    expect(answerPractice).not.toHaveBeenCalled();
    expect(screen.getByTestId('practice-progress').textContent).toBe('0 answered, 3 to go');
  });

  it('keeps every answered question when the learner stops part way', async () => {
    render(<PracticeRunner session={session} />);
    fireEvent.click(screen.getByTestId('practice-got-it'));
    await waitFor(() => expect(screen.getByTestId('practice-progress').textContent).toContain('1 answered'));
    fireEvent.click(screen.getByTestId('practice-stop'));

    expect(screen.getAllByTestId('practice-kept-question').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId('practice-summary').textContent).toContain('kept');
  });

  it('shows nothing-finished-yet as an empty state, not an error', async () => {
    startPractice.mockResolvedValue({ ok: false, error: { ...exampleAppError, code: 'conflict' } });
    render(<PracticePage />);
    await waitFor(() => expect(screen.getByTestId('load-empty').textContent).toBe(PRACTICE_EMPTY_MESSAGE));
    expect(screen.queryByTestId('load-error')).toBeNull();
    cleanup();

    startPractice.mockResolvedValue({ ok: false, error: exampleAppError });
    render(<PracticePage />);
    await waitFor(() => expect(screen.getByTestId('load-error')).toBeTruthy());
    expect(screen.queryByTestId('load-empty')).toBeNull();
  });

  it('maps only the nothing-finished failure onto empty', () => {
    expect(practiceState({ ok: true, data: session }).status).toBe('ready');
    expect(practiceState({ ok: false, error: { ...exampleAppError, code: 'conflict' } }).status).toBe('empty');
    expect(practiceState({ ok: false, error: exampleAppError }).status).toBe('error');
  });
});

describe('linking two subjects', () => {
  it('offers the conversation only when two subjects qualify', async () => {
    render(<SynthesisPage />);
    await waitFor(() => expect(screen.getByTestId('synthesis-picker')).toBeTruthy());
    fireEvent.click(screen.getByTestId('synthesis-start'));
    await waitFor(() => expect(openEvaluation).toHaveBeenCalled());
    expect(openEvaluation.mock.calls[0][0]).toMatchObject({ kind: 'synthesis' });
    expect(screen.getByTestId('synthesis-preview').textContent).toContain('Information theory');
  });

  it('explains plainly why it is unavailable instead of failing', async () => {
    getDashboard.mockResolvedValue({
      ok: true,
      data: { topics: [exampleDashboardTopic], reviewsDue: 0, synthesisAvailable: false },
    });
    render(<SynthesisPage />);
    await waitFor(() => expect(screen.getByTestId('load-empty').textContent).toBe(SYNTHESIS_UNAVAILABLE));
    expect(screen.queryByTestId('load-error')).toBeNull();
    expect(synthesisReady([exampleDashboardTopic])).toBe(false);
    expect(synthesisReady(twoSubjects.topics)).toBe(true);
  });

  it('shows a failed subject load as an error, never as unavailable', async () => {
    getDashboard.mockResolvedValue({ ok: false, error: exampleAppError });
    render(<SynthesisPage />);
    await waitFor(() => expect(screen.getByTestId('load-error')).toBeTruthy());
    expect(screen.queryByTestId('load-empty')).toBeNull();
  });
});
