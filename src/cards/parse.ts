// FRACTAL: implements F14 | component C7
import { MAX_CARD_SIDE_CHARS, type CardImport, type NewCard } from '@/shapes';

/**
 * Separators a learner's own list is likely to already use, longest first so that
 * "Carboxyl — -COOH" splits on the dash with spaces around it and not on the one inside
 * the formula.
 *
 * WHY a tab is first and a bare colon is last: a tab is unambiguous (it is what a
 * spreadsheet or a copied table gives you), while a colon shows up inside answers often
 * enough that it is only reached when nothing better matched.
 */
const SEPARATORS: readonly string[] = ['\t', ' — ', ' – ', ' -- ', ' | ', '|', ' - ', ' = ', ': '];

export const IMPORT_LINE_CAP = 500;

function splitLine(line: string): NewCard | null {
  for (const sep of SEPARATORS) {
    const at = line.indexOf(sep);
    if (at <= 0) continue;
    const front = line.slice(0, at).trim();
    const back = line.slice(at + sep.length).trim();
    if (front.length === 0 || back.length === 0) continue;
    if (front.length > MAX_CARD_SIDE_CHARS || back.length > MAX_CARD_SIDE_CHARS) return null;
    return { front, back };
  }
  return null;
}

/**
 * Reads a pasted list into cards.
 *
 * WHY nothing is guessed: a line with no separator is not turned into a one-sided card and
 * is not silently dropped either — it comes back in `skipped` so the learner can see the
 * three lines that did not make it rather than counting the ones that did. Same principle
 * as C11's "never truncated in silence".
 */
export function parseCardImport(text: string): CardImport {
  const cards: NewCard[] = [];
  const skipped: string[] = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (cards.length >= IMPORT_LINE_CAP) {
      skipped.push(line);
      continue;
    }
    const card = splitLine(line);
    if (card === null) {
      skipped.push(line);
      continue;
    }
    cards.push(card);
  }
  return { cards, skipped };
}
