// FRACTAL: covers F14, F2 | type unit
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { exampleCardDeck, exampleCardView, type CardPack } from '@/shapes';

const { CardPackPanel } = await import('@/ui/components/CardPackPanel');

const pack: CardPack = {
  name: 'Functional groups',
  why: 'Nothing derives the names.',
  cards: [
    { front: 'Carboxyl', back: 'minus COOH' },
    { front: 'Amine', back: 'minus NH2' },
  ],
};

const add = vi.fn();

describe('the cards a lesson proposes', () => {
  beforeEach(() => {
    add.mockReset();
    add.mockResolvedValue({ ok: true, data: { deck: exampleCardDeck, added: [exampleCardView], alreadyThere: 1 } });
  });

  afterEach(cleanup);

  it('shows what is on offer and adds nothing until the learner asks', () => {
    render(<CardPackPanel pack={pack} existingDeck={null} add={add} />);

    const list = screen.getByTestId('card-pack-list').textContent ?? '';
    expect(list).toContain('Carboxyl');
    expect(list).toContain('minus COOH');
    expect(add).not.toHaveBeenCalled();
    expect(screen.queryByTestId('card-pack-deck-link')).toBeNull();
  });

  it('says how many were new and how many were already there, and links to the deck', async () => {
    render(<CardPackPanel pack={pack} existingDeck={null} add={add} />);
    fireEvent.click(screen.getByTestId('add-card-pack'));

    await waitFor(() => expect(screen.getByTestId('card-pack-message').textContent).toContain('1 card added'));
    expect(screen.getByTestId('card-pack-message').textContent).toContain('already there');
    expect(screen.getByTestId('card-pack-deck-link').getAttribute('href')).toBe(`/cards/${exampleCardDeck.id}`);
  });

  it('opens already knowing the learner took these before', () => {
    render(<CardPackPanel pack={pack} existingDeck={exampleCardDeck} add={add} />);

    expect(screen.getByTestId('card-pack-deck-link')).not.toBeNull();
    expect(screen.getByTestId('add-card-pack').textContent).toContain('Check they are all in my cards');
  });

  it('reports a failure and keeps the pack on the page', async () => {
    add.mockResolvedValue({ ok: false, error: { code: 'internal', message: 'Could not save those.', correlationId: 'c_1' } });
    render(<CardPackPanel pack={pack} existingDeck={null} add={add} />);
    fireEvent.click(screen.getByTestId('add-card-pack'));

    await waitFor(() => expect(screen.getByTestId('card-pack-error').textContent).toContain('Could not save those.'));
    expect(screen.getByTestId('card-pack-list')).not.toBeNull();
  });
});
