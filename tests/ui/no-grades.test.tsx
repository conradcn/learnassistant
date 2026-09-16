// FRACTAL: covers F5, F10 | type unit
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { DashboardView } from '@/shapes';
import { exampleDashboardTopic, exampleHealthView, topicIdSchema } from '@/shapes';

const getDashboard = vi.fn();
const getHealth = vi.fn();

vi.mock('@/ui/api-client', () => ({
  getDashboard: () => getDashboard(),
  getHealth: () => getHealth(),
}));

const DashboardPage = (await import('../../app/page')).default;
const { capstoneLine, progressLine } = await import('@/ui/copy');
const { resetAppStore } = await import('@/ui/store');

const view: DashboardView = {
  topics: [
    exampleDashboardTopic,
    {
      ...exampleDashboardTopic,
      id: topicIdSchema.parse('t_1111111111111111'),
      subject: 'Information theory',
      status: 'modules-complete',
      completedCount: 12,
      availableCount: 0,
      remainingCount: 0,
      needsReviewCount: 2,
      assistedPassCount: 3,
      capstone: 'in-review',
    },
  ],
  reviewsDue: 2,
  synthesisAvailable: true,
};

const PERCENT = /\d\s*%|\bpercent\b/i;
const SCORE_WORDS = /\b(grade|score|mark|marks|points|pts|gpa|pass rate|out of \d+|\d+\s*\/\s*\d+)\b/i;
const LETTER_GRADE = /(^|\s)[A-F][+-]?(\s|[.,]|$)/;

beforeEach(() => {
  resetAppStore();
  getDashboard.mockResolvedValue({ ok: true, data: view });
  getHealth.mockResolvedValue({ ok: true, data: exampleHealthView });
});

afterEach(cleanup);

describe('progress is formative, never score-like', () => {
  it('renders no numeric or letter grade anywhere on the dashboard', async () => {
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getAllByTestId('dashboard-topic').length).toBe(2));
    const text = document.body.textContent ?? '';
    expect(PERCENT.test(text)).toBe(false);
    expect(SCORE_WORDS.test(text)).toBe(false);
    expect(LETTER_GRADE.test(text)).toBe(false);
  });

  it('says where the learner is and what is open next', async () => {
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getAllByTestId('progress-line').length).toBe(2));
    const lines = screen.getAllByTestId('progress-line').map((n) => n.textContent ?? '');
    expect(lines[0]).toContain('3 done');
    expect(lines[0]).toContain('2 open next');
    expect(lines[0]).toContain('7 still ahead');
  });

  // WHY the assisted count is absent rather than softly worded: it is a scheduling
  // input, and any phrasing of it on the dashboard is a running tally of lessons the
  // learner needed help with — the demerit this feature exists to avoid.
  it('frames review cues as cues, and never counts assisted passes at all', () => {
    const line = progressLine({
      ...exampleDashboardTopic,
      needsReviewCount: 2,
      assistedPassCount: 4,
    });
    expect(line).toBe('3 done · 2 open next · 7 still ahead · 2 worth a second look');
    expect(SCORE_WORDS.test(line)).toBe(false);
    expect(PERCENT.test(line)).toBe(false);
  });

  it('omits review cues entirely when there are none', () => {
    const line = progressLine({ ...exampleDashboardTopic, needsReviewCount: 0, assistedPassCount: 0 });
    expect(line).toBe('3 done · 2 open next · 7 still ahead');
  });

  it('distinguishes all-lessons-done from finished, without a total', () => {
    expect(capstoneLine({ ...exampleDashboardTopic, capstone: 'passed' })).toBe('Final project: finished.');
    expect(capstoneLine({ ...exampleDashboardTopic, capstone: 'not-started' })).toBe('Final project: not started yet.');
    const text = screen.queryByTestId('dashboard-list')?.textContent ?? '';
    expect(LETTER_GRADE.test(text)).toBe(false);
  });
});
