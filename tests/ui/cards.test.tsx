// FRACTAL: covers F14 | type unit
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CardView } from '@/shapes';
import { exampleCardView, cardIdSchema } from '@/shapes';

const gradeCard = vi.fn();

vi.mock('@/ui/api-client', () => ({
  gradeCard: (id: string, grade: string) => gradeCard(id, grade),
}));

const { CardStudy } = await import('@/ui/components/CardStudy');
const { deckLine, dueLine } = await import('@/ui/cards-copy');

const second = cardIdSchema.parse('cd_1111111111111111');
const cards: CardView[] = [
  { ...exampleCardView, front: 'Carboxyl group', back: 'minus COOH' },
  { ...exampleCardView, id: second, front: 'Amine', back: 'minus NH2', unseen: false },
];

describe('studying a deck', () => {
  beforeEach(() => {
    gradeCard.mockReset();
    gradeCard.mockResolvedValue({ ok: true, data: exampleCardView });
  });

  afterEach(cleanup);

  it('withholds the back of the card until the learner asks for it', () => {
    render(<CardStudy cards={cards} />);
    expect(screen.getByTestId('card-front').textContent).toContain('Carboxyl group');
    expect(screen.queryByTestId('card-back')).toBeNull();
    expect(screen.queryByTestId('card-grade-knew-it')).toBeNull();

    fireEvent.click(screen.getByTestId('card-reveal'));
    expect(screen.getByTestId('card-back').textContent).toContain('minus COOH');
  });

  it('records the answer and moves to the next card on the click', async () => {
    render(<CardStudy cards={cards} />);
    fireEvent.click(screen.getByTestId('card-reveal'));
    fireEvent.click(screen.getByTestId('card-grade-knew-it'));

    expect(gradeCard).toHaveBeenCalledWith(exampleCardView.id, 'knew-it');
    await waitFor(() => expect(screen.getByTestId('card-front').textContent).toContain('Amine'));
    // The next card starts face down again.
    expect(screen.queryByTestId('card-back')).toBeNull();
    expect(screen.getByTestId('study-note').textContent).toContain('further out');
  });

  it('says so when a recorded answer could not be saved, without losing the learner\'s place', async () => {
    gradeCard.mockResolvedValue({ ok: false, error: { code: 'internal', message: 'Could not save that.', correlationId: 'c_1' } });
    render(<CardStudy cards={cards} />);
    fireEvent.click(screen.getByTestId('card-reveal'));
    fireEvent.click(screen.getByTestId('card-grade-missed'));

    await waitFor(() => expect(screen.getByTestId('study-error').textContent).toContain('Could not save that.'));
    expect(screen.getByTestId('card-front').textContent).toContain('Amine');
  });

  it('ends with the round finished rather than an empty card', async () => {
    render(<CardStudy cards={[cards[0]]} />);
    fireEvent.click(screen.getByTestId('card-reveal'));
    fireEvent.click(screen.getByTestId('card-grade-hard'));
    await waitFor(() => expect(screen.getByTestId('study-finished')).toBeTruthy());
  });

  it('shows an empty queue as a normal place to be', () => {
    render(<CardStudy cards={[]} />);
    expect(screen.getByTestId('study-empty')).toBeTruthy();
  });
});

describe('the words on a deck', () => {
  it('never says how well the learner is doing, only what is waiting', () => {
    const line = deckLine({
      deck: { ...exampleCardView, name: 'x' } as never,
      subject: 'Organic chemistry',
      cardCount: 12,
      dueCount: 4,
    });
    expect(line).toBe('12 cards · 4 due · Organic chemistry');
    expect(line).not.toMatch(/\d+\s*%|score|grade/i);
  });

  it('marks a card that has never been answered as new', () => {
    expect(dueLine({ ...exampleCardView, unseen: true })).toBe('New card');
  });
});
