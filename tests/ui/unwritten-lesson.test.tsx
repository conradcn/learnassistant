// FRACTAL: covers F3 | type unit
/**
 * A planned-but-unwritten lesson and a lesson whose saved copy is broken are the same
 * `content: null` in the store, and for a while they were the same card on screen — so the
 * ordinary state after planning accused the app of losing the learner's data.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ApiResponse, ModuleNode, Reflection } from '@/shapes';
import { exampleEntryDecision, exampleModuleNode, exampleReflection } from '@/shapes';
import { LessonView } from '@/ui/components/LessonView';
import { resetAppStore } from '@/ui/store';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const unwritten: ModuleNode = { ...exampleModuleNode, content: null };

function ok(): Promise<ApiResponse<Reflection>> {
  return Promise.resolve({ ok: true, data: exampleReflection });
}

function renderLesson(contentIssue: 'never-written' | 'damaged' | null, onWrite = (): void => undefined) {
  return render(
    <LessonView
      module={unwritten}
      entry={exampleEntryDecision}
      saveNote={ok}
      contentIssue={contentIssue}
      onRetryAuthoring={onWrite}
      onRemove={(): void => undefined}
    />,
  );
}

afterEach(() => {
  cleanup();
  resetAppStore();
});

describe('a lesson with nothing to show', () => {
  it('says it has not been written yet, and never calls it damaged', () => {
    renderLesson('never-written');
    expect(screen.getByTestId('not-written-card')).toBeTruthy();
    expect(screen.queryByTestId('degraded-card')).toBeNull();
    expect(document.body.textContent).not.toMatch(/damaged/i);
  });

  it('offers to write it, and the offer is what the button does', () => {
    const onWrite = vi.fn();
    renderLesson('never-written', onWrite);
    fireEvent.click(screen.getByTestId('write-this-lesson'));
    expect(onWrite).toHaveBeenCalledTimes(1);
  });

  it('still reports a genuinely unreadable saved copy as damaged', () => {
    renderLesson('damaged');
    expect(screen.getByTestId('degraded-card')).toBeTruthy();
    expect(screen.queryByTestId('not-written-card')).toBeNull();
  });
});
