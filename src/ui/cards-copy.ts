// FRACTAL: implements F14 | component C10
import type { CardGrade, CardView, DeckSummary } from '@/shapes';

export const CARDS_INTRO =
  'Cards are for the things that just have to be known by heart — the names of the functional groups, a set of symbols, a table of dates. Everything else in here asks you to work something out; this asks you to remember it.';
export const CARDS_EMPTY_MESSAGE =
  'No decks yet. Make one for the things you just have to know by heart — names, symbols, dates.';
export const STUDY_EMPTY_MESSAGE =
  'Nothing due right now. Add cards, or come back when these come round again.';
export const DECK_EMPTY_MESSAGE = 'No cards in this deck yet. Add one below, or paste a whole list at once.';
export const PASTE_HELP =
  'One card per line, with the two sides separated by a dash, a tab, a colon or a pipe — "Carboxyl — -COOH".';
export const REVEAL_LABEL = 'Show the other side';
export const NEW_CARD_NOTE = 'New card';

/** Three buttons, in the order a learner meets them: worst news first. */
export const GRADE_LABELS: readonly { grade: CardGrade; label: string }[] = [
  { grade: 'missed', label: "Didn't know it" },
  { grade: 'hard', label: 'Knew it, slowly' },
  { grade: 'knew-it', label: 'Knew it' },
];

export function deckLine(summary: DeckSummary): string {
  const cards = summary.cardCount === 1 ? '1 card' : `${summary.cardCount} cards`;
  const subject = summary.subject === null ? '' : ` · ${summary.subject}`;
  if (summary.cardCount === 0) return `No cards yet${subject}`;
  if (summary.dueCount === 0) return `${cards} · none due right now${subject}`;
  return `${cards} · ${summary.dueCount} due${subject}`;
}

export function studyHeader(remaining: number, total: number): string {
  if (total === 0) return STUDY_EMPTY_MESSAGE;
  const done = total - remaining;
  return `${done} of ${total} this round`;
}

export function dueLine(card: CardView, now: Date = new Date()): string {
  if (card.unseen) return NEW_CARD_NOTE;
  const days = Math.floor((now.getTime() - Date.parse(card.dueAt)) / 86_400_000);
  if (days >= 1) return days === 1 ? 'due since yesterday' : `due for ${days} days`;
  if (days === 0 && Date.parse(card.dueAt) <= now.getTime()) return 'due now';
  const ahead = Math.ceil((Date.parse(card.dueAt) - now.getTime()) / 86_400_000);
  return ahead <= 1 ? 'comes back tomorrow' : `comes back in ${ahead} days`;
}

/**
 * WHY the wording never says how well it went: F5's rule that progress is never expressed
 * as a grade holds here too. The learner is told when the card comes back, not how they did.
 */
export function gradedLine(grade: CardGrade): string {
  if (grade === 'missed') return 'Noted — this one comes back soon.';
  if (grade === 'hard') return 'Noted — this one stays close by.';
  return 'Noted — this one moves further out.';
}

export function importLine(added: number, skipped: number): string {
  const cards = added === 1 ? '1 card added' : `${added} cards added`;
  if (skipped === 0) return cards;
  const lines = skipped === 1 ? '1 line' : `${skipped} lines`;
  return `${cards}. ${lines} had no two sides to split on, so nothing was made from them:`;
}

export const PACK_HEADING = 'Cards from this lesson';
export const PACK_ADD_LABEL = 'Add these to my cards';
export const PACK_ADD_AGAIN_LABEL = 'Check they are all in my cards';

/**
 * WHY the already-there count is spoken aloud: pressing the button a second time adds
 * nothing, and a panel that answered "added" either way would be describing a shelf the
 * learner does not have. It also never says a schedule moved, because none did.
 */
export function packAddedLine(added: number, alreadyThere: number): string {
  const cards = added === 1 ? '1 card added' : `${added} cards added`;
  if (alreadyThere === 0) return `${cards} to your cards.`;
  if (added === 0) return 'These are already in your cards, exactly as you left them.';
  return `${cards}. The other ${alreadyThere} were already there and were left alone.`;
}

export function packSummaryLine(count: number, deckName: string): string {
  const cards = count === 1 ? '1 card' : `${count} cards`;
  return `${cards} · “${deckName}”`;
}
