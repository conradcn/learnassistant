// FRACTAL: covers F3 | type unit | path lesson-body-is-interleaved
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { LessonBlock, ModuleNode } from '@/shapes';
import {
  exampleLessonBlock,
  exampleModuleContent,
  exampleModuleNode,
  exampleReflection,
  lessonBlockSchema,
  moduleContentSchema,
} from '@/shapes';
import { LessonBlocks } from '@/ui/components/LessonBlocks';
import { LessonView } from '@/ui/components/LessonView';
import { longestProseRun } from '@/ui/blocks';
import { resetSanitizeMemo } from '@/ui/sanitize';
import { resetAppStore } from '@/ui/store';

const CHECK: LessonBlock = exampleLessonBlock;

const REVEAL: LessonBlock = {
  kind: 'reveal',
  prompt: 'What is the entropy of a coin that always lands heads?',
  answer: 'Zero — there is **nothing left** to ask.',
};

const STEPS: LessonBlock = {
  kind: 'steps',
  title: 'Building up $H(X)$',
  steps: [
    { label: 'Surprise of one outcome', markdown: 'Write $\log_2(1/p)$.' },
    { label: 'Average it', markdown: 'Weight each surprise by its own $p$.' },
    { label: 'Name it', markdown: 'That average is the entropy.' },
  ],
};

const PLOT: LessonBlock = {
  kind: 'plot',
  title: 'Growth rate',
  caption: 'Turn $k$ up and the curve gets steeper long before it gets taller.',
  xLabel: 't',
  yLabel: 'N',
  xMin: 0,
  xMax: 5,
  params: [{ name: 'k', label: 'Growth rate $k$', min: 0, max: 3, step: 0.5, value: 1 }],
  curves: [{ label: '$e^{kt}$', expression: 'exp(k * x)' }],
};

function lessonWith(blocks: LessonBlock[] | undefined): ModuleNode {
  return { ...exampleModuleNode, content: { ...exampleModuleContent, blocks } };
}

function renderLessonPastTheGate(blocks: LessonBlock[] | undefined): void {
  render(
    <LessonView
      module={lessonWith(blocks)}
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

describe('the lesson body', () => {
  it('renders its blocks in the order they were written, inside the lesson', () => {
    renderLessonPastTheGate([
      { kind: 'prose', markdown: 'A fair coin costs one question.' },
      CHECK,
      { kind: 'prose', markdown: 'Weighted by probability, that count is the entropy.' },
    ]);
    const body = screen.getByTestId('lesson-blocks');
    expect(body.textContent).toContain('A fair coin costs one question.');
    expect(body.textContent).toContain('Weighted by probability');
    const order = Array.from(body.children).map((child) => child.getAttribute('data-testid'));
    expect(order[1]).toBe('block-check');
  });

  it('is absent rather than an empty box when the lesson has no blocks at all', () => {
    const { container } = render(<LessonBlocks blocks={undefined} />);
    expect(container.innerHTML).toBe('');
    expect(render(<LessonBlocks blocks={[]} />).container.innerHTML).toBe('');
  });

  it('leaves a lesson written before blocks existed exactly as it was', () => {
    renderLessonPastTheGate(undefined);
    expect(screen.getByTestId('explanation')).toBeTruthy();
    expect(screen.queryByTestId('lesson-blocks')).toBeNull();
  });
});

describe('an inline check', () => {
  it('says nothing about right or wrong until the learner commits to an answer', () => {
    render(<LessonBlocks blocks={[CHECK]} />);
    expect(screen.queryByTestId('check-feedback')).toBeNull();
    fireEvent.click(screen.getByTestId('check-option-1'));
    expect(screen.getByTestId('check-feedback').textContent).toContain('That is the one.');
  });

  it('names the right answer when the learner picks a wrong one, and explains the pick', () => {
    render(<LessonBlocks blocks={[CHECK]} />);
    fireEvent.click(screen.getByTestId('check-option-0'));
    const feedback = screen.getByTestId('check-feedback');
    expect(feedback.textContent).toContain('Not that one.');
    expect(feedback.textContent).toContain('Counting the outcomes');
  });

  it('lets a misclick be taken back — nothing is recorded, so nothing is locked', () => {
    render(<LessonBlocks blocks={[CHECK]} />);
    fireEvent.click(screen.getByTestId('check-option-0'));
    fireEvent.click(screen.getByTestId('check-option-1'));
    expect(screen.getByTestId('check-feedback').textContent).toContain('That is the one.');
    expect(screen.getByTestId('check-option-1').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('check-option-0').getAttribute('aria-pressed')).toBe('false');
  });

  it('typesets the math in its question and its options', () => {
    render(<LessonBlocks blocks={[CHECK]} />);
    expect(screen.getByTestId('check-question').querySelector('.katex')).toBeTruthy();
    expect(screen.getByTestId('check-option-1').querySelector('.katex')).toBeTruthy();
  });
});

describe('a reveal', () => {
  it('keeps the answer off the page until it is asked for', () => {
    render(<LessonBlocks blocks={[REVEAL]} />);
    expect(document.body.textContent ?? '').not.toContain('nothing left');
    fireEvent.click(screen.getByTestId('reveal-show'));
    expect(screen.getByTestId('reveal-answer').textContent).toContain('nothing left');
  });
});

describe('a derivation', () => {
  it('is printed whole, so line two is still there while line six is read', () => {
    render(<LessonBlocks blocks={[STEPS]} />);
    const body = screen.getByTestId('block-steps').textContent ?? '';
    expect(body).toContain('Write');
    expect(body).toContain('Weight each surprise');
    expect(body).toContain('That average is the entropy.');
  });

  it('has nothing left to click through', () => {
    render(<LessonBlocks blocks={[STEPS]} />);
    expect(screen.queryByTestId('steps-next')).toBeNull();
    expect(screen.queryByTestId('steps-back')).toBeNull();
  });
});

describe('an interactive plot', () => {
  it('draws a curve for each formula and labels the sliders', () => {
    render(<LessonBlocks blocks={[PLOT]} />);
    expect(screen.getByTestId('plot-curve-0').querySelectorAll('path').length).toBeGreaterThan(0);
    expect(screen.getByTestId('plot-value-k').textContent).toContain('k = 1');
  });

  it('moves the curve when the learner moves the slider', () => {
    render(<LessonBlocks blocks={[PLOT]} />);
    const before = screen.getByTestId('plot-curve-0').querySelector('path')?.getAttribute('d');
    fireEvent.change(screen.getByTestId('plot-slider-k'), { target: { value: '3' } });
    expect(screen.getByTestId('plot-value-k').textContent).toContain('k = 3');
    expect(screen.getByTestId('plot-curve-0').querySelector('path')?.getAttribute('d')).not.toBe(before);
  });

  it('can be put back where it started, and says so by going quiet', () => {
    render(<LessonBlocks blocks={[PLOT]} />);
    expect((screen.getByTestId('plot-reset') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('plot-slider-k'), { target: { value: '3' } });
    expect((screen.getByTestId('plot-reset') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('plot-reset'));
    expect(screen.getByTestId('plot-value-k').textContent).toContain('k = 1');
  });

  it('is readable without sight of it — the caption is the plot in words', () => {
    render(<LessonBlocks blocks={[PLOT]} />);
    const label = screen.getByTestId('plot-svg').getAttribute('aria-label') ?? '';
    expect(label).toContain('Growth rate');
    expect(label).toContain('steeper');
  });

  it('counts as something to do, not another wall of prose', () => {
    expect(longestProseRun([{ kind: 'prose', markdown: 'one' }, PLOT, { kind: 'prose', markdown: 'two' }])).toBe(1);
  });
});

describe('a lesson-written visualization', () => {
  const INTERACTIVE: LessonBlock = {
    kind: 'interactive',
    title: 'Halving',
    caption: 'Click until one is left.',
    html: '<button id="b">Ask</button><script>b.onclick=()=>{}</script>',
    height: 200,
  };

  function fromFrame(frame: HTMLIFrameElement, data: unknown): void {
    fireEvent(window, new MessageEvent('message', { data, source: frame.contentWindow }));
  }

  it('runs in a sandboxed frame at the frame route, never inline in the page', () => {
    render(<LessonBlocks blocks={[INTERACTIVE]} />);
    const frame = screen.getByTestId('interactive-frame') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('src')).toBe('/viz-frame');
    expect(frame.hasAttribute('srcdoc')).toBe(false);
    // The code is nowhere in the page's own DOM — it only ever exists inside the frame.
    expect(screen.getByTestId('block-interactive').innerHTML).not.toContain('onclick');
  });

  it('hands its code over when the frame says it is listening, and to no one else', () => {
    render(<LessonBlocks blocks={[INTERACTIVE]} />);
    const frame = screen.getByTestId('interactive-frame') as HTMLIFrameElement;
    const target = frame.contentWindow as Window;
    const sent: unknown[] = [];
    target.postMessage = ((message: unknown) => sent.push(message)) as Window['postMessage'];

    // A ready message from some other window is ignored.
    fireEvent(window, new MessageEvent('message', { data: { type: 'la-viz-ready' }, source: window }));
    expect(sent).toEqual([]);

    fromFrame(frame, { type: 'la-viz-ready' });
    expect(sent).toEqual([{ type: 'la-viz-render', html: INTERACTIVE.html }]);
  });

  it('grows to the height its content reports, within bounds', () => {
    render(<LessonBlocks blocks={[INTERACTIVE]} />);
    const frame = screen.getByTestId('interactive-frame') as HTMLIFrameElement;
    expect(frame.style.height).toBe('200px');
    fromFrame(frame, { type: 'la-viz-height', height: 420 });
    expect(frame.style.height).toBe('420px');
    fromFrame(frame, { type: 'la-viz-height', height: 99999 });
    expect(frame.style.height).toBe('1600px');
  });

  it('counts as something to do', () => {
    expect(longestProseRun([{ kind: 'prose', markdown: 'one' }, INTERACTIVE, { kind: 'prose', markdown: 'two' }])).toBe(1);
  });
});

describe('a figure block', () => {
  it('draws the diagram and strips anything executable out of it', () => {
    render(
      <LessonBlocks
        blocks={[
          {
            kind: 'figure',
            svg: '<svg onload="steal()"><script>steal()</script><circle cx="1" cy="1" r="1" /></svg>',
            caption: 'Eight outcomes, three questions.',
          },
        ]}
      />,
    );
    const html = screen.getByTestId('block-figure').innerHTML;
    expect(html).toContain('circle');
    expect(html).not.toContain('script');
    expect(html).not.toContain('onload');
    expect(screen.getByTestId('block-figure').textContent).toContain('Eight outcomes');
  });
});

describe('the block contract', () => {
  it('refuses a check whose answer does not point at one of its options', () => {
    const parsed = lessonBlockSchema.safeParse({
      kind: 'check',
      question: 'q',
      options: ['a', 'b'],
      answerIndex: 2,
      whyRight: 'r',
      whyWrong: 'w',
    });
    expect(parsed.success).toBe(false);
  });

  it('leaves blocks absent rather than empty when content was written without them', () => {
    // WHY this matters beyond tidiness: content is stored beside a digest of itself, and a
    // schema default would materialise `blocks: []` into lessons digested without the field,
    // failing every stored lesson's checksum.
    const parsed = moduleContentSchema.parse({ ...exampleModuleContent });
    expect('blocks' in parsed).toBe(false);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(exampleModuleContent));
  });

  it('counts how far a learner reads without meeting anything to look at or do', () => {
    expect(longestProseRun([])).toBe(0);
    expect(
      longestProseRun([
        { kind: 'prose', markdown: 'one' },
        CHECK,
        { kind: 'prose', markdown: 'two' },
        { kind: 'prose', markdown: 'three' },
      ]),
    ).toBe(2);
  });
});
