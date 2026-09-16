// FRACTAL: covers F3 | type unit
//
// WHY: a model writes the titles and the subject lines, and it writes them in the same
// LaTeX it writes a lesson body in. Rendering one of those strings as a text node puts
// `$\log_2 8 = 3$` on the page verbatim — and the repo's rule is that maths is typeset
// everywhere a learner meets it, not only on the lesson page. These tests pin the three
// surfaces a title travels through and the one string that is rendered on two screens.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Suspense } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { DashboardView, ReviewCue, TopicDetailView } from '@/shapes';
import {
  exampleDashboardTopic,
  exampleHealthView,
  exampleModuleAvailability,
  exampleModuleGraph,
  exampleModuleNode,
  exampleModuleId,
  exampleEntryDecision,
  exampleReviewCue,
  exampleTopic,
  exampleTopicId,
  exampleProviderView,
} from '@/shapes';

/**
 * KaTeX keeps the LaTeX source in a MathML `<annotation>`, so `textContent` still holds
 * the backslashes even when the formula is typeset. What the learner actually sees is the
 * HTML branch, which KaTeX marks `aria-hidden`; this reads exactly that.
 */
function visibleText(root: Element | null): string {
  if (root === null) return '';
  const clone = root.cloneNode(true) as Element;
  for (const hidden of Array.from(clone.querySelectorAll('.katex-mathml'))) hidden.remove();
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

const MATHY_TITLE = 'Why $\log_2 8 = 3$';
const MATHY_SUBJECT = 'Logarithms, or why $\log_2 8 = 3$';

const getDashboard = vi.fn();
const getHealth = vi.fn();
const getTopic = vi.fn();
const getProvider = vi.fn();
const getModule = vi.fn();
const resumeEvaluation = vi.fn();

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

vi.mock('@/ui/api-client', () => ({
  getDashboard: () => getDashboard(),
  getHealth: () => getHealth(),
  getTopic: (...a: unknown[]) => getTopic(...a),
  getProvider: () => getProvider(),
  getModule: (...a: unknown[]) => getModule(...a),
  resumeEvaluation: (...a: unknown[]) => resumeEvaluation(...a),
  openEvaluation: vi.fn(),
  restartEvaluation: vi.fn(),
  sendEvaluationMessage: vi.fn(),
  recordReview: vi.fn(),
  getReviewsDue: vi.fn(),
  deleteTopic: vi.fn(),
  requestDetour: vi.fn(),
  startGeneration: vi.fn(),
}));

const DashboardPage = (await import('../../app/page')).default;
const TopicPage = (await import('../../app/topics/[id]/page')).default;
const EvaluationPage = (await import('../../app/modules/[id]/eval/page')).default;
const { ReviewQueue } = await import('@/ui/components/ReviewQueue');
const { toCard } = await import('@/ui/review-copy');
const { resetAppStore } = await import('@/ui/store');
const { resetSanitizeMemo } = await import('@/ui/sanitize');

const dashboard: DashboardView = {
  topics: [{ ...exampleDashboardTopic, subject: MATHY_SUBJECT }],
  reviewsDue: 1,
  synthesisAvailable: false,
};

const topicDetail: TopicDetailView = {
  topic: { ...exampleTopic, id: exampleTopicId, subject: MATHY_SUBJECT },
  graph: exampleModuleGraph,
  availability: [exampleModuleAvailability],
  extensions: [],
};

beforeEach(() => {
  resetAppStore();
  resetSanitizeMemo();
  vi.clearAllMocks();
  getHealth.mockResolvedValue({ ok: true, data: exampleHealthView });
  getDashboard.mockResolvedValue({ ok: true, data: dashboard });
  getTopic.mockResolvedValue({ ok: true, data: topicDetail });
  getProvider.mockResolvedValue({ ok: true, data: exampleProviderView });
  getModule.mockResolvedValue({
    ok: true,
    data: {
      module: { ...exampleModuleNode, id: exampleModuleId, title: MATHY_TITLE },
      entry: exampleEntryDecision,
      prediction: null,
      calibration: null,
      contentIssue: null,
    },
  });
  resumeEvaluation.mockResolvedValue({ ok: true, data: null });
});

afterEach(cleanup);

describe('model-authored titles are typeset, not printed', () => {
  it('typesets a module title in the review queue heading', () => {
    const cues: ReviewCue[] = [{ ...exampleReviewCue }];
    const cards = cues.map((cue) => toCard(cue, MATHY_TITLE));
    render(<ReviewQueue cards={cards} dueTotal={cards.length} />);
    const heading = screen.getByTestId('review-card').querySelector('h2');
    expect(heading?.querySelector('.katex')).not.toBeNull();
    expect(visibleText(heading)).toBe('Why log2​8=3');
  });

  it('typesets the subject on a dashboard card', async () => {
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getAllByTestId('dashboard-topic').length).toBe(1));
    const card = screen.getByTestId('dashboard-topic');
    expect(card.querySelector('.katex')).not.toBeNull();
    expect(visibleText(card.querySelector('h2'))).toContain('Logarithms, or why log2​8=3');
  });

  it('typesets the module title in the eval page heading', async () => {
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <EvaluationPage params={Promise.resolve({ id: exampleModuleId })} />
        </Suspense>,
      );
    });
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.querySelector('.katex')).not.toBeNull();
    expect(visibleText(heading)).toBe('Talking through: Why log2​8=3');
  });

  // The point of the rule is that one string does not depend on which screen it landed
  // on: the dashboard card and the subject page must typeset `topic.subject` the same way.
  it('renders topic.subject identically on the dashboard and on the topic page', async () => {
    const dash = render(<DashboardPage />);
    await waitFor(() => expect(screen.getAllByTestId('dashboard-topic').length).toBe(1));
    const fromDashboard =
      screen.getByTestId('dashboard-topic').querySelector('a > span')?.innerHTML ?? '';
    dash.unmount();

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <TopicPage params={Promise.resolve({ id: exampleTopicId })} />
        </Suspense>,
      );
    });
    const topicHeading = await screen.findByRole('heading', { level: 1 });
    const fromTopicPage = topicHeading.querySelector('span:not(.la-badge)')?.innerHTML ?? '';

    expect(fromDashboard).not.toBe('');
    expect(fromTopicPage).toBe(fromDashboard);
  });
});
