// FRACTAL: covers F4 | type unit
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Suspense } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { EvalSession } from '@/shapes';
import {
  exampleEntryDecision,
  exampleEvalSession,
  exampleEvalTurn,
  exampleModuleId,
  exampleModuleNode,
} from '@/shapes';

const getModule = vi.fn();
const resumeEvaluation = vi.fn();
const openEvaluation = vi.fn();

vi.mock('@/ui/api-client', () => ({
  getModule: (...a: unknown[]) => getModule(...a),
  resumeEvaluation: (...a: unknown[]) => resumeEvaluation(...a),
  openEvaluation: (...a: unknown[]) => openEvaluation(...a),
  restartEvaluation: vi.fn(),
  continueEvaluation: vi.fn(),
  sendEvaluationMessage: vi.fn(),
}));

const EvaluationPage = (await import('../../app/modules/[id]/eval/page')).default;
const { resetAppStore } = await import('@/ui/store');

const TUTOR_TEXT = [
  '## What went wrong',
  '',
  '- you dropped the sign',
  '- the discriminant is under the root',
  '',
  'The roots are $\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}$.',
].join('\n');

function session(status: EvalSession['status'], verdictId: string): EvalSession {
  return {
    ...exampleEvalSession,
    status,
    turns: [
      { ...exampleEvalTurn, id: 'l0', role: 'learner', text: 'My answer.' },
      { ...exampleEvalTurn, id: verdictId, role: 'evaluator', text: TUTOR_TEXT, mode: 'verdict' },
    ],
  };
}

async function renderPage(): Promise<void> {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <EvaluationPage params={Promise.resolve({ id: exampleModuleId })} />
      </Suspense>,
    );
  });
}

function tutorRow(): HTMLElement {
  return screen.getByTestId('chat-turn-evaluator');
}

beforeEach(() => {
  resetAppStore();
  getModule.mockReset();
  resumeEvaluation.mockReset();
  openEvaluation.mockReset();
  getModule.mockResolvedValue({
    ok: true,
    data: {
      module: { ...exampleModuleNode, title: 'Quadratics' },
      entry: exampleEntryDecision,
      prediction: null,
      calibration: null,
      contentIssue: null,
    },
  });
});

afterEach(cleanup);

/**
 * WHY: the tutor is instructed to write markdown and $…$ maths (src/cli/prompt.ts), and the
 * live transcript renders it as such. The finished transcript a learner comes back to used
 * to render the same string as a bare text node, so a passed lesson showed literal ##, -,
 * ** and raw LaTeX collapsed into one paragraph.
 */
describe('the finished transcript renders the tutor exactly as the live one does', () => {
  it('typesets maths and marks up lists rather than showing the source', async () => {
    resumeEvaluation.mockResolvedValue({ ok: true, data: session('passed', 'v1:pass') });

    await renderPage();

    await waitFor(() => expect(screen.getByTestId('eval-finished')).not.toBeNull());
    const row = tutorRow();
    expect(row.querySelector('.katex')).not.toBeNull();
    expect(row.querySelectorAll('li').length).toBe(2);
    expect(row.querySelector('h2')).not.toBeNull();
    const text = row.textContent ?? '';
    expect(text).not.toContain('## What went wrong');
    // The delimiters are consumed by the typesetter; the LaTeX source survives only inside
    // KaTeX's own MathML annotation, which is not what the learner reads.
    expect(text).not.toContain('$');
  });

  it('produces the same markup on both branches for the same turn text', async () => {
    resumeEvaluation.mockResolvedValue({ ok: true, data: session('passed', 'v1:pass') });
    await renderPage();
    await waitFor(() => expect(screen.getByTestId('eval-finished')).not.toBeNull());
    const finished = tutorRow().innerHTML;

    cleanup();
    resetAppStore();

    resumeEvaluation.mockResolvedValue({ ok: true, data: session('open', 'v1:continue') });
    await renderPage();
    await waitFor(() => expect(screen.getByTestId('chat-panel')).not.toBeNull());
    const live = tutorRow().innerHTML;

    expect(finished).toBe(live);
  });
});
