// FRACTAL: covers F4 | type unit
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApiResponse, EvalTurnResult } from '@/shapes';
import { exampleEvalTurnResult } from '@/shapes';
import { ChatPanel } from '@/ui/components/ChatPanel';
import { EVALUATOR_SILENT_MESSAGE } from '@/eval/turn';

const failure: ApiResponse<EvalTurnResult> = {
  ok: false,
  error: { code: 'cli-failed', message: EVALUATOR_SILENT_MESSAGE, correlationId: 'c1' },
};

function renderPanel(persist: () => Promise<ApiResponse<EvalTurnResult>>) {
  return render(
    <ChatPanel
      draftKey="chat-retry-test"
      turns={[]}
      composerLabel="Your answer"
      sendLabel="Send"
      emptyMessage="Nothing yet"
      persist={persist}
      onResult={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe('a send the evaluator never answers', () => {
  // WHY this is the case worth a test: the failure message tells the learner to press
  // Retry. If no such control is rendered, the message is a dead end.
  it('offers a Retry control that resends the restored text', async () => {
    const success: ApiResponse<EvalTurnResult> = { ok: true, data: exampleEvalTurnResult };
    const persist = vi
      .fn((): Promise<ApiResponse<EvalTurnResult>> => Promise.resolve(failure))
      .mockResolvedValueOnce(failure)
      .mockResolvedValue(success);
    renderPanel(persist);

    fireEvent.change(screen.getByTestId('chat-text'), { target: { value: 'my answer' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() =>
      expect(screen.getByTestId('chat-composer-error').textContent).toContain('did not respond'),
    );
    expect((screen.getByTestId('chat-text') as HTMLTextAreaElement).value).toBe('my answer');
    // the outage must not cost the text on reload either. WHY awaited rather than read
    // straight after the message appears: the draft is written by an effect, and an effect
    // is committed after the paint that reveals the error — on a loaded machine, reading it
    // synchronously reads the moment in between.
    await waitFor(() => expect(sessionStorage.getItem('chat-retry-test')).toBe('my answer'));

    fireEvent.click(screen.getByTestId('chat-retry'));
    await waitFor(() => expect(persist).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('chat-composer-error')).toBeNull());
  });
});
