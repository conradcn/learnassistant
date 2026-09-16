// FRACTAL: covers F3 | type unit | path module-has-no-visualization
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ModuleNode, Visualization } from '@/shapes';
import { exampleModuleContent, exampleModuleNode, exampleReflection } from '@/shapes';
import { VisualizationView } from '@/ui/components/VisualizationView';
import { LessonView } from '@/ui/components/LessonView';
import { hasVisualization } from '@/ui/lesson';
import { resetSanitizeMemo } from '@/ui/sanitize';
import { resetAppStore } from '@/ui/store';

function lesson(visualization: Visualization): ModuleNode {
  return { ...exampleModuleNode, content: { ...exampleModuleContent, visualization } };
}

function renderLessonPastTheGate(visualization: Visualization): void {
  render(
    <LessonView
      module={lesson(visualization)}
      entry={{ enterable: true, advisory: null }}
      saveNote={() => Promise.resolve({ ok: true, data: exampleReflection })}
      contentIssue={null}
      onRetryAuthoring={(): void => undefined}
      onRemove={(): void => undefined}
    />,
  );
  fireEvent.click(screen.getByTestId('warm-up-skip'));
}

afterEach(() => {
  cleanup();
  resetSanitizeMemo();
  resetAppStore();
});

describe('the visualization section', () => {
  it('is absent entirely when the lesson has no picture — not an empty box', () => {
    const { container } = render(<VisualizationView visualization={{ kind: 'none' }} />);
    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('visualization')).toBeNull();
    expect(hasVisualization({ kind: 'none' })).toBe(false);
  });

  it('leaves no placeholder inside a full lesson either', () => {
    renderLessonPastTheGate({ kind: 'none' });
    expect(screen.getByTestId('explanation')).toBeTruthy();
    expect(screen.queryByTestId('visualization')).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('A picture of it');
  });

  it('draws a picture when there is one, with its caption', () => {
    renderLessonPastTheGate({
      kind: 'svg',
      svg: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" /></svg>',
      caption: 'Eight outcomes, three questions.',
    });
    const figure = screen.getByTestId('visualization-svg');
    expect(figure.querySelector('circle')).toBeTruthy();
    expect(figure.textContent).toContain('Eight outcomes, three questions.');
    expect(hasVisualization({ kind: 'svg', svg: '<svg />', caption: '' })).toBe(true);
  });

  it('strips anything executable out of a drawn picture', () => {
    render(
      <VisualizationView
        visualization={{
          kind: 'svg',
          svg: '<svg onload="steal()"><script>steal()</script><circle cx="1" cy="1" r="1" onclick="steal()" /></svg>',
          caption: 'ok',
        }}
      />,
    );
    const html = screen.getByTestId('visualization-svg').innerHTML;
    expect(html).not.toContain('script');
    expect(html).not.toContain('onload');
    expect(html).not.toContain('onclick');
    expect(html).toContain('circle');
  });

  it('renders a table of numbers as a table', () => {
    render(
      <VisualizationView
        visualization={{
          kind: 'table',
          headers: ['Symbol', 'Bits'],
          rows: [['a', '1'], ['b', '2']],
          caption: 'Code lengths',
        }}
      />,
    );
    const table = screen.getByTestId('visualization-table');
    expect(table.querySelectorAll('th')).toHaveLength(2);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(table.textContent).toContain('Code lengths');
  });
});
