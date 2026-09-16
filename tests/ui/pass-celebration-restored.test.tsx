// FRACTAL: covers F4, F10 | type unit
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Suspense } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { EvalSession, EvalTurn } from '@/shapes';
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
  sendEvaluationMessage: vi.fn(),
}));

const EvaluationPage = (await import('../../app/modules/[id]/eval/page')).default;
const { resetAppStore } = await import('@/ui/store');

function evaluatorTurn(id: string): EvalTurn {
  return { ...exampleEvalTurn, id, role: 'evaluator', text: 'Tutor said something.', mode: 'verdict' };
}

function sessionEndingIn(id: string, status: EvalSession['status']): EvalSession {
  return {
    ...exampleEvalSession,
    status,
    turns: [
      { ...exampleEvalTurn, id: 'l0', role: 'learner', text: 'My answer.' },
      evaluatorTurn(id),
    ],
  };
}

// The page unwraps its `params` promise with `use`, so the first render suspends; the
// act scope has to be awaited or the tree never commits.
async function renderPage(): Promise<void> {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <EvaluationPage params={Promise.resolve({ id: exampleModuleId })} />
      </Suspense>,
    );
  });
}

beforeEach(() => {
  resetAppStore();
  getModule.mockReset();
  resumeEvaluation.mockReset();
  openEvaluation.mockReset();
  getModule.mockResolvedValue({
    ok: true,
    data: {
      module: { ...exampleModuleNode, title: 'Reading Math Notation Like a Type Signature' },
      entry: exampleEntryDecision,
      prediction: null,
      calibration: null,
      contentIssue: null,
    },
  });
});

afterEach(cleanup);

/**
 * WHY these exist: the celebration originally fired only on the live turn, so it was
 * invisible on every later visit — and entirely absent for a lesson passed before it was
 * built, or for a pass registered retroactively after the criteria gate had wrongly
 * swallowed it. The verdict lives in the turn ids, so a restored transcript can say so too.
 */
describe('a conversation that was already passed still says so on a later visit', () => {
  it('celebrates a restored pass, without needing a fresh turn', async () => {
    resumeEvaluation.mockResolvedValue({ ok: true, data: sessionEndingIn('v1:pass', 'passed') });

    await renderPage();

    await waitFor(() => expect(screen.getByTestId('pass-celebration')).not.toBeNull());
    expect(screen.getByTestId('eval-outcome').textContent).toBe('That one is done. Nice work.');
    expect(screen.getByTestId('pass-celebration-title').textContent).toContain(
      'Reading Math Notation Like a Type Signature',
    );
    // The transcript is still there underneath — the celebration does not replace it.
    expect(screen.getByTestId('chat-transcript')).not.toBeNull();
    expect(openEvaluation).not.toHaveBeenCalled();
  });

  // WHY: the assist level books an earlier review (F7); it is never reported back to the
  // learner, so a restored assisted pass reads exactly like a clean one.
  it('reads an assisted pass exactly like a clean one', async () => {
    resumeEvaluation.mockResolvedValue({ ok: true, data: sessionEndingIn('v1:assisted-pass', 'passed') });

    await renderPage();

    await waitFor(() => expect(screen.getByTestId('pass-celebration')).not.toBeNull());
    expect(screen.getByTestId('eval-outcome').textContent).toBe('That one is done. Nice work.');
    expect(document.body.textContent ?? '').not.toContain('help');
  });

  it('shows exactly one celebration, never a second copy beside the live one', async () => {
    resumeEvaluation.mockResolvedValue({ ok: true, data: sessionEndingIn('v1:pass', 'passed') });

    await renderPage();

    await waitFor(() => expect(screen.getByTestId('pass-celebration')).not.toBeNull());
    expect(screen.getAllByTestId('pass-celebration').length).toBe(1);
    expect(screen.getAllByTestId('eval-outcome').length).toBe(1);
  });

  it('says nothing celebratory about a conversation still in progress', async () => {
    resumeEvaluation.mockResolvedValue({ ok: true, data: sessionEndingIn('v1:continue', 'open') });

    await renderPage();

    await waitFor(() => expect(screen.getByTestId('chat-panel')).not.toBeNull());
    expect(screen.queryByTestId('pass-celebration')).toBeNull();
  });
});
