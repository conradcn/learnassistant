// FRACTAL: covers F4, F10 | type unit
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PassCelebration } from '@/ui/components/PassCelebration';

const PERCENT = /\d\s*%|\bpercent\b/i;
const SCORE_WORDS = /\b(grade|score|mark|marks|points|pts|gpa|streak|out of \d+|\d+\s*\/\s*\d+)\b/i;

afterEach(cleanup);

describe('passing a lesson is marked, not merely reported', () => {
  it('keeps the outcome line where the page has always put it', () => {
    render(<PassCelebration title="Reading Math Notation" line="That one is done. Nice work." />);
    expect(screen.getByTestId('eval-outcome').textContent).toBe('That one is done. Nice work.');
    expect(screen.getByTestId('pass-celebration')).not.toBeNull();
    expect(screen.getByTestId('pass-celebration-title').textContent).toContain('Reading Math Notation');
  });

  // WHY: how much help a pass took is a review-scheduling input, not something the
  // learner is shown — a qualified congratulation is a demerit in a nicer voice.
  it('reads the same however much help the pass took', () => {
    render(<PassCelebration title="A lesson" line="Done." />);
    expect(screen.getByTestId('pass-celebration-headline').textContent).toBe('That is yours now.');
  });

  // WHY: the app has no marks anywhere (see no-grades.test.tsx), and a celebration is
  // exactly the place a score, percentage or streak would quietly get introduced.
  it('celebrates without inventing a score', () => {
    render(<PassCelebration title="A lesson" line="That one is done. Nice work." />);
    const text = document.body.textContent ?? '';
    expect(PERCENT.test(text)).toBe(false);
    expect(SCORE_WORDS.test(text)).toBe(false);
  });
});
