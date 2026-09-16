// FRACTAL: covers F3 | type unit
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApiResponse, EntryDecision, ModuleNode, Reflection } from '@/shapes';
import {
  exampleAppError,
  exampleEntryDecision,
  exampleModuleContent,
  exampleModuleNode,
  exampleReflection,
  moduleIdSchema,
} from '@/shapes';
import { LessonView } from '@/ui/components/LessonView';
import { advisorySentence, unmetPrereqTitles } from '@/ui/lesson';
import { resetAppStore } from '@/ui/store';

const moduleWithContent: ModuleNode = { ...exampleModuleNode, content: exampleModuleContent };

const twoUnmet: EntryDecision = {
  enterable: true,
  advisory: {
    unmetPrereqs: [
      { id: exampleModuleNode.id, title: 'Probability refresher' },
      { id: moduleIdSchema.parse('m_0d9fQ2xK4mZa71bC'), title: 'Logarithms' },
    ],
  },
};

function ok(): Promise<ApiResponse<Reflection>> {
  return Promise.resolve({ ok: true, data: exampleReflection });
}

function renderLesson(entry: EntryDecision, saveNote: () => Promise<ApiResponse<Reflection>> = ok) {
  return render(
    <LessonView
      module={moduleWithContent}
      entry={entry}
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

describe('the unmet-prerequisite advisory', () => {
  it('names what is missing and offers a way in, never a lock', () => {
    renderLesson(exampleEntryDecision);

    const advisory = screen.getByTestId('prereq-advisory');
    expect(advisory.textContent).toContain('Probability refresher');
    expect(screen.getByTestId('acknowledge-advisory')).toBeTruthy();
    expect((screen.getByTestId('acknowledge-advisory') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('learning-goals')).toBeTruthy();
  });

  it('takes exactly one click to get past, on the click’s own tick', () => {
    const saveNote = vi.fn(() => new Promise<ApiResponse<Reflection>>(() => undefined));
    renderLesson(twoUnmet, saveNote);

    fireEvent.click(screen.getByTestId('acknowledge-advisory'));

    expect(screen.queryByTestId('prereq-advisory')).toBeNull();
    expect(screen.queryByTestId('acknowledge-advisory')).toBeNull();
    expect(screen.getByTestId('warm-up')).toBeTruthy();
    expect(saveNote).toHaveBeenCalledTimes(1);
  });

  it('shows no advisory at all when every prerequisite is met', () => {
    renderLesson({ enterable: true, advisory: null });
    expect(screen.queryByTestId('prereq-advisory')).toBeNull();
    expect(screen.getByTestId('warm-up')).toBeTruthy();
  });

  it('puts the learner back on the advisory with a reason when the note cannot be saved', async () => {
    renderLesson(exampleEntryDecision, () => Promise.resolve({ ok: false, error: exampleAppError }));

    fireEvent.click(screen.getByTestId('acknowledge-advisory'));
    expect(screen.queryByTestId('prereq-advisory')).toBeNull();

    await waitFor(() => expect(screen.getByTestId('prereq-advisory')).toBeTruthy());
    expect(screen.getByTestId('lesson-error').textContent).toBe(exampleAppError.message);
    expect((screen.getByTestId('acknowledge-advisory') as HTMLButtonElement).disabled).toBe(false);
  });

  it('words the advice as advice, with no code and no talk of being blocked', () => {
    renderLesson(twoUnmet);
    const text = screen.getByTestId('prereq-advisory-text').textContent ?? '';
    expect(text).toContain('Probability refresher and Logarithms');
    expect(text).toContain('You can still start here.');
    expect(text.toLowerCase()).not.toContain('locked');
    expect(text.toLowerCase()).not.toContain('prereq');
  });

  it('reads the missing titles straight off the entry decision', () => {
    expect(unmetPrereqTitles(twoUnmet)).toEqual(['Probability refresher', 'Logarithms']);
    expect(unmetPrereqTitles({ enterable: true, advisory: null })).toEqual([]);
    expect(advisorySentence(['Logarithms'])).toContain('Logarithms');
  });
});
