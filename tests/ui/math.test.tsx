// FRACTAL: covers F3 | type unit
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { hasMath, renderMath, splitMath } from '@/ui/math';
import { renderMarkdown, renderTextWithMath, resetSanitizeMemo } from '@/ui/sanitize';
import { MathText } from '@/ui/components/MathText';
import type { ModuleGraph, ModuleNode } from '@/shapes';
import { exampleModuleGraph, exampleModuleNode, moduleIdSchema } from '@/shapes';
import { GraphView } from '@/ui/components/GraphView';
import { resetGraphLayoutMemo } from '@/ui/graph-layout';

beforeEach(() => {
  resetSanitizeMemo();
  cleanup();
});

describe('splitMath', () => {
  it('finds inline math between single dollars', () => {
    expect(splitMath('energy is $E = mc^2$ exactly')).toEqual([
      { kind: 'text', value: 'energy is ' },
      { kind: 'math', tex: 'E = mc^2', display: false },
      { kind: 'text', value: ' exactly' },
    ]);
  });

  it('prefers the double-dollar display form over two inline runs', () => {
    expect(splitMath('$$a + b$$')).toEqual([{ kind: 'math', tex: 'a + b', display: true }]);
  });

  it('accepts the bracket and paren delimiters too', () => {
    expect(splitMath('\\(x\\) and \\[y\\]')).toEqual([
      { kind: 'math', tex: 'x', display: false },
      { kind: 'text', value: ' and ' },
      { kind: 'math', tex: 'y', display: true },
    ]);
  });

  // WHY: a price is the single most common way a dollar appears in a non-maths lesson.
  // Swallowing the rest of the paragraph on an unpaired delimiter would be a visible,
  // frequent corruption of ordinary prose.
  it('leaves a lone dollar as text rather than opening a formula', () => {
    expect(splitMath('it costs $100 today')).toEqual([
      { kind: 'text', value: 'it costs $100 today' },
    ]);
  });

  it('honours a backslash-escaped dollar', () => {
    expect(splitMath('costs \\$5 and \\$6')).toEqual([
      { kind: 'text', value: 'costs $5 and $6' },
    ]);
  });

  it('does not typeset dollars inside a code span', () => {
    expect(splitMath('use `$PATH` and $x$')).toEqual([
      { kind: 'text', value: 'use `$PATH` and ' },
      { kind: 'math', tex: 'x', display: false },
    ]);
  });

  it('reports whether a string contains anything to typeset', () => {
    expect(hasMath('plain prose')).toBe(false);
    expect(hasMath('a $b$ c')).toBe(true);
  });
});

describe('renderMath', () => {
  // The TeX source survives on purpose, in the MathML <annotation> — that is what a screen
  // reader announces and what a copy-paste yields. What must not survive is the *visual*
  // layer showing backslashes, so that is what is asserted.
  it('typesets a formula into KaTeX markup', () => {
    const html = renderMath('\\frac{1}{2}', false);
    expect(html).toContain('class="katex"');
    expect(html).toContain('mfrac');
    expect(html).toContain('<annotation encoding="application/x-tex">\\frac{1}{2}</annotation>');
    const visual = html.slice(html.indexOf('katex-html'));
    expect(visual).not.toContain('\\frac');
  });

  it('marks display math as display', () => {
    expect(renderMath('x', true)).toContain('katex-display');
    expect(renderMath('x', false)).not.toContain('katex-display');
  });

  // WHY: every character came from a model. A lesson with one malformed formula must still
  // teach the rest of itself rather than throwing on render.
  it('degrades invalid LaTeX instead of throwing', () => {
    expect(() => renderMath('\\frac{', false)).not.toThrow();
    expect(renderMath('\\nosuchcommand', false).length).toBeGreaterThan(0);
  });

  it('does not emit script from a formula that tries to smuggle markup', () => {
    const html = renderMath('\\text{<script>alert(1)</script>}', false);
    expect(html).not.toContain('<script>');
  });
});

describe('markdown with math', () => {
  it('typesets math inside a paragraph and still escapes the prose around it', () => {
    const html = renderMarkdown('Then $x^2$ <b>grows</b>.');
    expect(html).toContain('katex');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('typesets math in list items and blockquotes', () => {
    expect(renderMarkdown('- first $a$\n- second $b$')).toContain('katex');
    expect(renderMarkdown('> recall $e^{i\\pi} = -1$')).toContain('katex');
  });

  // WHY: a fenced block is where a lesson shows shell or code; typesetting its dollars
  // would corrupt exactly the content that must be shown literally.
  it('leaves a fenced code block untouched', () => {
    const html = renderMarkdown('```\necho $HOME and $x$\n```');
    expect(html).not.toContain('katex');
    expect(html).toContain('$HOME');
  });

  it('keeps markdown emphasis working alongside math', () => {
    const html = renderMarkdown('**bold** and $y$');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('katex');
  });
});

describe('MathText', () => {
  it('typesets a plain-string field', () => {
    render(<MathText testId="goal" text="Compute $\\int_0^1 x\\,dx$." />);
    expect(screen.getByTestId('goal').querySelector('.katex')).not.toBeNull();
  });

  it('renders as the requested element', () => {
    render(<MathText as="p" testId="stem" text="plain" />);
    expect(screen.getByTestId('stem').tagName).toBe('P');
  });

  it('escapes markup in a field that carries no math', () => {
    render(<MathText testId="x" text="<script>alert(1)</script>" />);
    const node = screen.getByTestId('x');
    expect(node.querySelector('script')).toBeNull();
    expect(node.textContent).toContain('<script>');
  });

  it('is memoised on identical input', () => {
    const a = renderTextWithMath('value $z$');
    expect(renderTextWithMath('value $z$')).toBe(a);
  });
});

/* WHY (F3): the overview is where a learner first meets a lesson's name, and titles like
   "Why $e^{i\pi} = -1$" arrive from the same author as the lesson body — printing them as
   raw text there contradicted the typeset copy one click later. */
describe('the lesson overview', () => {
  it('typesets math in a lesson title and in the sentence naming its prerequisites', () => {
    resetGraphLayoutMemo();
    const mathIds = {
      first: exampleModuleNode.id,
      second: moduleIdSchema.parse('m_9d9fQ2xK4mZa71bC'),
    };
    const base = (id: typeof mathIds.first, title: string, state: ModuleNode['state'], ordinal: number): ModuleNode => ({
      ...exampleModuleNode,
      id,
      title,
      state,
      ordinal,
      content: null,
    });
    const graph: ModuleGraph = {
      ...exampleModuleGraph,
      nodes: [
        base(mathIds.first, 'Euler: $e^{i\pi} = -1$', 'completed', 1),
        base(mathIds.second, 'Series for $\sin x$', 'available', 2),
      ],
      edges: [{ from: mathIds.first, to: mathIds.second }],
      entryModules: [mathIds.first],
    };
    render(
      <GraphView
        graph={graph}
        availability={[
          { moduleId: mathIds.first, state: 'completed', unmetPrereqs: [] },
          { moduleId: mathIds.second, state: 'available', unmetPrereqs: [] },
        ]}
      />,
    );
    const open = screen.getByTestId('graph-open-node');
    expect(open.querySelector('h3 .katex')).not.toBeNull();
    expect(open.querySelector('.la-meta .katex')).not.toBeNull();
    expect(screen.getByTestId('graph-done-node').querySelector('h3 .katex')).not.toBeNull();
  });
});
