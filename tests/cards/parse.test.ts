// FRACTAL: covers F14 | type unit
import { describe, expect, it } from 'vitest';
import { parseCardImport } from '@/cards/parse';

describe('reading a pasted list into cards', () => {
  it('splits on the separators a learner\'s own list already uses', () => {
    const result = parseCardImport(
      [
        'Carboxyl — -COOH',
        'Hydroxyl\t-OH',
        'Amine: -NH2',
        'Carbonyl | C=O',
        'Ester = -COO-',
      ].join('\n'),
    );
    expect(result.skipped).toEqual([]);
    expect(result.cards).toEqual([
      { front: 'Carboxyl', back: '-COOH' },
      { front: 'Hydroxyl', back: '-OH' },
      { front: 'Amine', back: '-NH2' },
      { front: 'Carbonyl', back: 'C=O' },
      { front: 'Ester', back: '-COO-' },
    ]);
  });

  it('keeps a dash inside the answer, splitting on the spaced separator instead', () => {
    const result = parseCardImport('Carboxyl — -COOH, a carbonyl and a hydroxyl');
    expect(result.cards).toEqual([{ front: 'Carboxyl', back: '-COOH, a carbonyl and a hydroxyl' }]);
  });

  it('hands back the lines it could not split rather than guessing or dropping them', () => {
    const result = parseCardImport(['Amine: -NH2', 'a line with no two sides', '', '   '].join('\n'));
    expect(result.cards).toHaveLength(1);
    expect(result.skipped).toEqual(['a line with no two sides']);
  });

  it('reads nothing out of an empty paste', () => {
    expect(parseCardImport('\n\n   \n')).toEqual({ cards: [], skipped: [] });
  });
});
