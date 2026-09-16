// FRACTAL: covers F10, F11 | type unit
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApiResponse, Reflection } from '@/shapes';
import {
  exampleAppError,
  exampleCalibrationView,
  exampleDashboardTopic,
  exampleModuleId,
  exampleReflection,
} from '@/shapes';

const getDashboard = vi.fn();
const saveReflection = vi.fn();
const editReflection = vi.fn();
const recordPrediction = vi.fn();

vi.mock('@/ui/api-client', () => ({
  getDashboard: () => getDashboard(),
  saveReflection: (input: unknown) => saveReflection(input),
  editReflection: (id: string, text: string) => editReflection(id, text),
  recordPrediction: (prediction: unknown) => recordPrediction(prediction),
}));

const JournalPage = (await import('../../app/journal/page')).default;
const { PredictionPrompt } = await import('@/ui/components/PredictionPrompt');
const { CalibrationCard } = await import('@/ui/components/CalibrationCard');
const { JOURNAL_EMPTY_MESSAGE, JOURNAL_NO_SUBJECTS, entryText, newestFirst } = await import('@/ui/journal-copy');

const LONG_NOTE = 'The prior is the belief you bring before the data.\n\nSTILL confusing: why it must sum to 1.';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  getDashboard.mockResolvedValue({
    ok: true,
    data: { topics: [exampleDashboardTopic], reviewsDue: 0, synthesisAvailable: false },
  });
  saveReflection.mockImplementation((input: { text: string }) =>
    Promise.resolve({ ok: true, data: { ...exampleReflection, id: 'r_saved', text: input.text } }),
  );
  editReflection.mockImplementation((id: string, text: string) =>
    Promise.resolve({ ok: true, data: { ...exampleReflection, id, text, updatedAt: exampleReflection.updatedAt } }),
  );
  recordPrediction.mockImplementation((prediction: unknown) => Promise.resolve({ ok: true, data: prediction }));
});

afterEach(cleanup);

async function openJournal(): Promise<void> {
  render(<JournalPage />);
  await waitFor(() => expect(screen.getByTestId('journal')).toBeTruthy());
}

describe('the reflection journal', () => {
  it('starts with an explicit nothing-written-yet state', async () => {
    await openJournal();
    expect(screen.getByTestId('journal-empty').textContent).toBe(JOURNAL_EMPTY_MESSAGE);
    expect(screen.queryByTestId('load-error')).toBeNull();
  });

  it('shows a saved note back word for word, on the same tick', async () => {
    const gate = deferred<ApiResponse<Reflection>>();
    saveReflection.mockReturnValue(gate.promise);
    await openJournal();

    fireEvent.change(screen.getByTestId('reflection-text'), { target: { value: LONG_NOTE } });
    fireEvent.click(screen.getByTestId('reflection-save'));

    expect(screen.getByTestId('journal-entry-text').textContent).toBe(LONG_NOTE);
    expect((screen.getByTestId('reflection-save') as HTMLButtonElement).disabled).toBe(false);

    gate.resolve({ ok: true, data: { ...exampleReflection, id: 'r_saved', text: LONG_NOTE } });
    await waitFor(() => expect(screen.getAllByTestId('journal-entry').length).toBe(1));
    expect(screen.getByTestId('journal-entry-text').textContent).toBe(LONG_NOTE);
  });

  it('takes the note back out and says why when the save fails, keeping the text', async () => {
    saveReflection.mockResolvedValue({ ok: false, error: exampleAppError });
    await openJournal();

    fireEvent.change(screen.getByTestId('reflection-text'), { target: { value: LONG_NOTE } });
    fireEvent.click(screen.getByTestId('reflection-save'));
    expect(screen.getByTestId('journal-entry-text').textContent).toBe(LONG_NOTE);

    await waitFor(() => expect(screen.getByTestId('reflection-error').textContent).toBe(exampleAppError.message));
    expect(screen.queryByTestId('journal-entry')).toBeNull();
    expect((screen.getByTestId('reflection-text') as HTMLTextAreaElement).value).toBe(LONG_NOTE);
  });

  it('shows the latest version after an edit, still verbatim', async () => {
    await openJournal();
    fireEvent.change(screen.getByTestId('reflection-text'), { target: { value: 'first thought' } });
    fireEvent.click(screen.getByTestId('reflection-save'));
    await waitFor(() => expect(screen.getByTestId('journal-edit-r_saved')).toBeTruthy());

    fireEvent.click(screen.getByTestId('journal-edit-r_saved'));
    const boxes = screen.getAllByTestId('reflection-text');
    const box = boxes[boxes.length - 1];
    fireEvent.change(box, { target: { value: 'second thought, said properly' } });
    fireEvent.click(screen.getAllByTestId('reflection-save')[1]);

    await waitFor(() =>
      expect(screen.getByTestId('journal-entry-text').textContent).toBe('second thought, said properly'),
    );
    expect(editReflection).toHaveBeenCalledWith('r_saved', 'second thought, said properly');
  });

  it('never summarises or reorders the stored text', () => {
    const older: Reflection = { ...exampleReflection, id: 'r_a', text: 'older note' };
    const newer: Reflection = {
      ...exampleReflection,
      id: 'r_b',
      text: 'newer note',
      updatedAt: exampleReflection.updatedAt,
    };
    expect(entryText(older)).toBe('older note');
    expect(newestFirst([older, newer]).length).toBe(2);
  });

  it('shows a failed subject load as an error, not as nothing written', async () => {
    getDashboard.mockResolvedValue({ ok: false, error: exampleAppError });
    render(<JournalPage />);
    await waitFor(() => expect(screen.getByTestId('load-error')).toBeTruthy());
    expect(screen.queryByTestId('load-empty')).toBeNull();
    cleanup();

    getDashboard.mockResolvedValue({ ok: true, data: { topics: [], reviewsDue: 0, synthesisAvailable: false } });
    render(<JournalPage />);
    await waitFor(() => expect(screen.getByTestId('load-empty').textContent).toBe(JOURNAL_NO_SUBJECTS));
  });
});

describe('the prediction prompt', () => {
  it('records the answer on the same tick without blocking anything', async () => {
    const gate = deferred<ApiResponse<unknown>>();
    recordPrediction.mockReturnValue(gate.promise);
    render(<PredictionPrompt moduleId={exampleModuleId} />);

    const button = screen.getByTestId('prediction-level-4');
    fireEvent.click(button);
    expect(screen.getByTestId('prediction-recorded').textContent).toContain('fairly confident');
    expect((button as HTMLButtonElement).disabled).toBe(false);

    gate.resolve({ ok: true, data: { moduleId: exampleModuleId, confidence: 4, expectation: '', skipped: false, at: exampleReflection.updatedAt } });
    await waitFor(() => expect(screen.getByTestId('prediction-recorded')).toBeTruthy());
  });

  it('treats skipping as a first-class answer and rolls back a failure', async () => {
    recordPrediction.mockResolvedValue({ ok: false, error: exampleAppError });
    render(<PredictionPrompt moduleId={exampleModuleId} />);

    fireEvent.click(screen.getByTestId('prediction-skip'));
    expect(screen.getByTestId('prediction-recorded')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('prediction-error').textContent).toBe(exampleAppError.message));
    expect(screen.queryByTestId('prediction-recorded')).toBeNull();
    expect(recordPrediction.mock.calls[0][0]).toMatchObject({ skipped: true });
  });

  it('shows an earlier answer back instead of asking again, and only re-asks when told to', () => {
    render(
      <PredictionPrompt
        moduleId={exampleModuleId}
        existing={{ moduleId: exampleModuleId, confidence: 2, expectation: '', skipped: false, at: exampleReflection.updatedAt }}
      />,
    );

    expect(screen.getByTestId('prediction-recorded').textContent).toContain('shaky on this');
    expect(screen.queryByTestId('prediction-level-4')).toBeNull();
    expect(screen.queryByTestId('prediction-skip')).toBeNull();

    fireEvent.click(screen.getByTestId('prediction-change'));
    expect(screen.getByTestId('prediction-level-4')).toBeTruthy();
  });
});

describe('the calibration card', () => {
  it('compares what was expected with how it went, with no mark of any kind', () => {
    render(<CalibrationCard view={exampleCalibrationView} />);
    const text = screen.getByTestId('calibration-card').textContent ?? '';
    expect(screen.getByTestId('calibration-predicted').textContent).toContain('expected it to feel easy');
    expect(screen.getByTestId('calibration-actual').textContent).toContain('took a couple of nudges');
    expect(/\d/.test(text)).toBe(false);
    expect(/\b[A-F][+-]?\b/.test(text)).toBe(false);
    expect(text.toLowerCase()).not.toContain('score');
    expect(text.toLowerCase()).not.toContain('%');
  });

  it('stays silent about self-ratings when the learner gave none', () => {
    render(<CalibrationCard view={{ ...exampleCalibrationView, selfVsEvaluator: [], predictedLabel: null }} />);
    expect(screen.queryByTestId('calibration-self')).toBeNull();
    expect(screen.getByTestId('calibration-predicted').textContent).toContain('did not rate your confidence');
  });
});
