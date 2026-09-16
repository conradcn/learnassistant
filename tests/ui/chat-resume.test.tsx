// FRACTAL: covers F4 | type unit
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { isoDateStringSchema, type ApiResponse, type EvalTurn, type EvalTurnResult } from '@/shapes';
import { exampleEvalTurnResult } from '@/shapes';
import { ChatPanel } from '@/ui/components/ChatPanel';
import { EVALUATOR_SILENT_MESSAGE } from '@/eval/turn';

const learnerLast: EvalTurn[] = [
  {
    id: 'v0:continue',
    role: 'evaluator',
    text: 'Where does the average come from?',
    assistLevel: 0,
    angle: null,
    mode: 'question',
    selfAssessment: null,
    at: isoDateStringSchema.parse('2026-01-01T00:00:00.000Z'),
  },
  {
    id: 'l1',
    role: 'learner',
    text: 'from the distribution over symbols',
    assistLevel: null,
    angle: null,
    mode: 'question',
    selfAssessment: null,
    at: isoDateStringSchema.parse('2026-01-01T00:01:00.000Z'),
  },
];

function renderPanel(turns: EvalTurn[], resume?: () => Promise<ApiResponse<EvalTurnResult | null>>) {
  return render(
    <ChatPanel
      draftKey="chat-resume-test"
      turns={turns}
      composerLabel="Your answer"
      sendLabel="Send"
      emptyMessage="Nothing yet"
      persist={() => Promise.resolve({ ok: true, data: exampleEvalTurnResult })}
      resume={resume}
      onResult={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

// WHY: a turn interrupted after the learner's message was saved leaves the transcript
// ending on them with nothing running. The panel used to draw a composer under it and
// wait, so the only way on was to type the same answer again.
describe('a transcript that is owed a reply', () => {
  it('asks for the owed reply on its own', async () => {
    const resume = vi.fn(
      (): Promise<ApiResponse<EvalTurnResult | null>> => Promise.resolve({ ok: true, data: exampleEvalTurnResult }),
    );
    renderPanel(learnerLast, resume);

    await waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('chat-turn-resuming')).toBeNull());
  });

  it('leaves a transcript whose last word is the tutor alone', async () => {
    const resume = vi.fn(
      (): Promise<ApiResponse<EvalTurnResult | null>> => Promise.resolve({ ok: true, data: null }),
    );
    renderPanel([learnerLast[0]], resume);

    await waitFor(() => expect(screen.getByTestId('chat-text')).toBeTruthy());
    expect(resume).not.toHaveBeenCalled();
  });

  it('offers Retry when the resumed turn fails too', async () => {
    const failure: ApiResponse<EvalTurnResult | null> = {
      ok: false,
      error: { code: 'cli-failed', message: EVALUATOR_SILENT_MESSAGE, correlationId: 'c1' },
    };
    const resume = vi
      .fn((): Promise<ApiResponse<EvalTurnResult | null>> => Promise.resolve(failure))
      .mockResolvedValueOnce(failure)
      .mockResolvedValue({ ok: true, data: exampleEvalTurnResult });
    renderPanel(learnerLast, resume);

    await waitFor(() =>
      expect(screen.getByTestId('chat-resume-error').textContent).toContain('did not respond'),
    );
    fireEvent.click(screen.getByTestId('chat-resume-retry'));
    await waitFor(() => expect(resume).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('chat-resume-error')).toBeNull());
  });
});
