// FRACTAL: covers F3 | type unit
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApiResponse, LessonQuestion } from '@/shapes';
import { exampleAppError } from '@/shapes';
import { AskPanel } from '@/ui/components/AskPanel';

afterEach(cleanup);

function answered(answer: string): Promise<ApiResponse<LessonQuestion>> {
  return Promise.resolve({ ok: true, data: { question: 'Why bits?', answer } });
}

describe('asking a question about the lesson', () => {
  it('shows what was asked on an earlier visit, with the answer', () => {
    render(
      <AskPanel
        asked={[{ question: 'Why bits?', answer: 'Because a bit **is** one question.' }]}
        ask={() => answered('unused')}
      />,
    );
    expect(screen.getByTestId('ask-history').textContent).toContain('Why bits?');
    expect(screen.getByTestId('ask-answer').textContent).toContain('Because a bit is one question.');
  });

  it('says the question is with the tutor while it waits, and shows the answer when it lands', async () => {
    let settle: (r: ApiResponse<LessonQuestion>) => void = () => undefined;
    const ask = vi.fn(
      () => new Promise<ApiResponse<LessonQuestion>>((resolve) => { settle = resolve; }),
    );
    render(<AskPanel asked={[]} ask={ask} />);

    fireEvent.change(screen.getByTestId('ask-text'), { target: { value: 'Why bits?' } });
    fireEvent.submit(screen.getByTestId('ask-text').closest('form') as HTMLFormElement);

    expect(ask).toHaveBeenCalledWith('Why bits?');
    expect(screen.getByTestId('ask-pending')).toBeTruthy();
    expect((screen.getByTestId('ask-send') as HTMLButtonElement).disabled).toBe(true);

    settle({ ok: true, data: { question: 'Why bits?', answer: 'One yes/no question.' } });
    await waitFor(() => expect(screen.queryByTestId('ask-pending')).toBeNull());
    expect(screen.getByTestId('ask-history').textContent).toContain('One yes/no question.');
    expect((screen.getByTestId('ask-text') as HTMLTextAreaElement).value).toBe('');
  });

  it('gives a failed question back to the learner rather than making them retype it', async () => {
    render(
      <AskPanel asked={[]} ask={() => Promise.resolve({ ok: false as const, error: exampleAppError })} />,
    );
    fireEvent.change(screen.getByTestId('ask-text'), { target: { value: 'Why bits?' } });
    fireEvent.submit(screen.getByTestId('ask-text').closest('form') as HTMLFormElement);

    await waitFor(() => expect(screen.getByTestId('ask-error')).toBeTruthy());
    expect((screen.getByTestId('ask-text') as HTMLTextAreaElement).value).toBe('Why bits?');
  });

  it('does not send an empty question', () => {
    const ask = vi.fn(() => answered('never'));
    render(<AskPanel asked={[]} ask={ask} />);
    fireEvent.change(screen.getByTestId('ask-text'), { target: { value: '   ' } });
    fireEvent.submit(screen.getByTestId('ask-text').closest('form') as HTMLFormElement);
    expect(ask).not.toHaveBeenCalled();
  });
});
