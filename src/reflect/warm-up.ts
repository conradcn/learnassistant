// FRACTAL: implements F3 | component C8
import type { WarmUpRecord } from '@/shapes';

/**
 * WHY: the first go was already written down as a reflection note, but only the note was
 * kept — the page's memory of having answered lived in component state and died with the
 * tab. Coming back to a lesson then wiped the learner's own words off the screen and asked
 * for them again. The note is the record; these two markers are how it is read back.
 */
export const WARM_UP_NOTE_PREFIX = 'First thoughts before reading: ';
export const WARM_UP_SKIP_NOTE = 'Went straight to the explanation without trying the warm-up first.';

export function warmUpNote(text: string): string {
  return `${WARM_UP_NOTE_PREFIX}${text}`;
}

/** The learner's most recent first go at this lesson, or null if they have not had one. */
export function warmUpFromNotes(texts: readonly string[]): WarmUpRecord | null {
  let found: WarmUpRecord | null = null;
  // WHY last-wins: notes arrive oldest first, and a later attempt is the one to show back.
  for (const text of texts) {
    if (text.startsWith(WARM_UP_NOTE_PREFIX)) {
      found = { stage: 'attempted', text: text.slice(WARM_UP_NOTE_PREFIX.length) };
    } else if (text === WARM_UP_SKIP_NOTE) {
      found = { stage: 'skipped', text: '' };
    }
  }
  return found;
}
