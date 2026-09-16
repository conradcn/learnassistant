// FRACTAL: covers F3 | type unit
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApiResponse, ModuleNode, Reflection, WarmUpRecord } from '@/shapes';
import {
  exampleAppError,
  exampleEntryDecision,
  exampleModuleContent,
  exampleModuleNode,
  exampleReflection,
} from '@/shapes';
import { LessonView } from '@/ui/components/LessonView';
import { ExplanationView } from '@/ui/components/ExplanationView';
import { explanationVisible } from '@/ui/lesson';
import { resetAppStore } from '@/ui/store';

const NO_ADVISORY = { enterable: true, advisory: null } as const;

const moduleWithContent: ModuleNode = {
  ...exampleModuleNode,
  content: {
    ...exampleModuleContent,
    learningGoals: ['State entropy as expected surprise', 'Compare two codes'],
    explanation: { kind: 'text', markdown: 'Entropy is an **expectation**.' },
  },
};

function ok(): Promise<ApiResponse<Reflection>> {
  return Promise.resolve({ ok: true, data: exampleReflection });
}

function renderLesson(
  saveNote: () => Promise<ApiResponse<Reflection>>,
  warmUpRecord: WarmUpRecord | null = null,
) {
  return render(
    <LessonView
      module={moduleWithContent}
      entry={NO_ADVISORY}
      warmUpRecord={warmUpRecord}
      saveNote={saveNote}
      contentIssue={null}
      onRetryAuthoring={(): void => undefined}
      onRemove={(): void => undefined}
    />,
  );
}

afterEach(() => {
  cleanup();
  resetAppStore();
});

describe('the warm-up gate', () => {
  it('shows the learning goals and the warm-up, and no explanation at all, before the learner has had a go', () => {
    renderLesson(ok);

    const goals = screen.getByTestId('learning-goals');
    expect(goals.textContent).toContain('State entropy as expected surprise');
    expect(screen.getByTestId('warm-up-prompt').textContent).toBe(exampleModuleContent.warmUp.prompt);
    expect(screen.queryByTestId('explanation')).toBeNull();
    expect(screen.queryByTestId('text-explanation')).toBeNull();
  });

  it('renders the goals before the explanation in document order once the warm-up is attempted', () => {
    renderLesson(ok);
    fireEvent.change(screen.getByTestId('warm-up-answer'), { target: { value: 'three questions' } });
    fireEvent.click(screen.getByTestId('warm-up-submit'));

    const goals = screen.getByTestId('learning-goals');
    const explanation = screen.getByTestId('explanation');
    expect(goals.compareDocumentPosition(explanation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('reveals the explanation on the same tick the attempt is made, without waiting for the save', () => {
    const saveNote = vi.fn(() => new Promise<ApiResponse<Reflection>>(() => undefined));
    renderLesson(saveNote);

    fireEvent.change(screen.getByTestId('warm-up-answer'), { target: { value: 'three questions' } });
    fireEvent.click(screen.getByTestId('warm-up-submit'));

    expect(screen.getByTestId('explanation')).toBeTruthy();
    expect(saveNote).toHaveBeenCalledTimes(1);
    expect((saveNote.mock.calls[0] as unknown as string[])[0]).toContain('three questions');
  });

  it('reveals the explanation when the warm-up is explicitly skipped', () => {
    renderLesson(ok);
    expect(screen.queryByTestId('explanation')).toBeNull();

    fireEvent.click(screen.getByTestId('warm-up-skip'));

    expect(screen.getByTestId('explanation')).toBeTruthy();
    expect(screen.getByTestId('warm-up-settled').textContent).toContain('straight on');
  });

  it('ignores an empty attempt so the explanation stays behind the gate', () => {
    const saveNote = vi.fn(ok);
    renderLesson(saveNote);

    fireEvent.click(screen.getByTestId('warm-up-submit'));

    expect(saveNote).not.toHaveBeenCalled();
    expect(screen.queryByTestId('explanation')).toBeNull();
  });

  it('keeps both controls enabled while the note is being written', () => {
    renderLesson(() => new Promise<ApiResponse<Reflection>>(() => undefined));
    fireEvent.change(screen.getByTestId('warm-up-answer'), { target: { value: 'a guess' } });
    const submit = screen.getByTestId('warm-up-submit') as HTMLButtonElement;
    const skip = screen.getByTestId('warm-up-skip') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(skip.disabled).toBe(false);
  });

  it('rolls the gate back and says what went wrong when the note cannot be saved', async () => {
    renderLesson(() => Promise.resolve({ ok: false, error: exampleAppError }));

    fireEvent.change(screen.getByTestId('warm-up-answer'), { target: { value: 'a guess' } });
    fireEvent.click(screen.getByTestId('warm-up-submit'));
    expect(screen.getByTestId('explanation')).toBeTruthy();

    await waitFor(() => expect(screen.queryByTestId('explanation')).toBeNull());
    expect(screen.getByTestId('warm-up-error').textContent).toBe(exampleAppError.message);
    expect((screen.getByTestId('warm-up-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the first go when the lesson is opened again, rather than asking for a new one', () => {
    const saveNote = vi.fn(ok);
    renderLesson(saveNote, { stage: 'attempted', text: 'three questions' });

    expect(screen.queryByTestId('warm-up-answer')).toBeNull();
    expect(screen.getByTestId('warm-up-saved-answer').textContent).toContain('three questions');
    expect(screen.getByTestId('explanation')).toBeTruthy();
    expect(saveNote).not.toHaveBeenCalled();
  });

  it('remembers a skip too, and does not put the gate back in front of the explanation', () => {
    renderLesson(ok, { stage: 'skipped', text: '' });

    expect(screen.queryByTestId('warm-up-answer')).toBeNull();
    expect(screen.queryByTestId('warm-up-saved-answer')).toBeNull();
    expect(screen.getByTestId('warm-up-settled').textContent).toContain('straight on');
    expect(screen.getByTestId('explanation')).toBeTruthy();
  });

  it('states the gate as a pure function of the stage', () => {
    expect(explanationVisible('not-attempted')).toBe(false);
    expect(explanationVisible('attempted')).toBe(true);
    expect(explanationVisible('skipped')).toBe(true);
  });

  it('never shows a blank lesson when the saved content is unreadable', () => {
    render(
      <LessonView
        module={{ ...exampleModuleNode, content: null }}
        entry={exampleEntryDecision}
        saveNote={ok}
        contentIssue={null}
        onRetryAuthoring={(): void => undefined}
        onRemove={(): void => undefined}
      />,
    );
    expect(screen.getByTestId('degraded-card')).toBeTruthy();
    expect(screen.queryByTestId('lesson-view')).toBeNull();
  });
});

describe('the explanation itself', () => {
  it('opens a video in a new tab and refuses to link one from a host we do not know', () => {
    render(
      <ExplanationView
        explanation={{
          kind: 'video',
          url: 'https://www.youtube.com/watch?v=ErfnhcEV1O8',
          title: 'Information entropy',
          channel: '3Blue1Brown',
          durationSec: 612,
          why: 'Visual derivation at exactly this level.',
        }}
      />,
    );
    const link = screen.getByTestId('video-link') as HTMLAnchorElement;
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    cleanup();

    render(
      <ExplanationView
        explanation={{
          kind: 'video',
          url: 'http://evil.example.com/watch',
          title: 'Information entropy',
          channel: 'unknown',
          durationSec: 612,
          why: 'nope',
        }}
      />,
    );
    expect(screen.queryByTestId('video-link')).toBeNull();
    expect(screen.getByTestId('video-blocked').textContent).toContain('not made it clickable');
  });

  it('renders written explanations as formatted text with no raw markup from the writer', () => {
    render(
      <ExplanationView
        explanation={{
          kind: 'text',
          markdown: ['# Entropy', '', 'It is an **expectation**.', '', '<img src=x onerror="steal()">'].join(String.fromCharCode(10)),
        }}
      />,
    );
    const rendered = screen.getByTestId('text-explanation');
    expect(rendered.querySelector('h1')?.textContent).toBe('Entropy');
    expect(rendered.querySelector('strong')?.textContent).toBe('expectation');
    expect(rendered.querySelector('img')).toBeNull();
    expect(rendered.querySelector('[onerror]')).toBeNull();
    expect(rendered.textContent).toContain('<img src=x onerror="steal()">');
  });
});
