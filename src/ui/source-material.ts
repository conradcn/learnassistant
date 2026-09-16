// FRACTAL: implements F1 | component C10
import type { Level, StagedSource } from '@/shapes';

/**
 * What the intake form says about material the learner brought.
 *
 * WHY these are pure functions and not inline JSX: every one of them is a sentence the
 * learner reads at the moment they are deciding whether the app understood their
 * syllabus, and each has a case that is easy to get subtly wrong — one unit versus many,
 * a book that disagrees with the level they picked, a document too long to keep whole.
 * Pulled out here they are asserted directly rather than through a rendered tree.
 */

const LEVEL_WORDS: Readonly<Record<Level, string>> = {
  beginner: 'a first course',
  intermediate: 'a second course',
  advanced: 'graduate or advanced work',
  'self-described': 'a level you described yourself',
};

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** The line under each attached file: what we got out of it, in the learner's terms. */
export function materialSummary(source: StagedSource): string {
  const parts: string[] = [];
  if (source.pageCount !== null) parts.push(plural(source.pageCount, 'page', 'pages'));
  parts.push(
    source.units.length === 0
      ? 'no unit list found'
      : plural(source.units.length, 'unit', 'units'),
  );
  parts.push(plural(source.charCount, 'character', 'characters'));
  return parts.join(' · ');
}

/** The subject to pre-fill from, which is the first piece of material that named one. */
export function inferredSubjectFrom(materials: readonly StagedSource[]): string | null {
  for (const source of materials) {
    if (source.inferredSubject !== null) return source.inferredSubject;
  }
  return null;
}

/**
 * WHY this is a note and never a correction: a book is evidence about the book. A learner
 * who picks "new to it" and uploads a graduate text has told us both things on purpose
 * often enough — they were handed that text and they are new to it. The lessons stay at
 * the level they chose; this only says the two disagree, so it is not a surprise later.
 */
export function levelClash(materials: readonly StagedSource[], chosen: Level): string | null {
  if (chosen === 'self-described') return null;
  const signal = materials.find((m) => m.levelSignal !== null && m.levelSignal !== chosen);
  if (signal === undefined || signal.levelSignal === null) return null;
  return (
    `${signal.filename} reads like ${LEVEL_WORDS[signal.levelSignal]}, and you said ${LEVEL_WORDS[chosen]}. ` +
    'We will pitch the lessons at the level you chose and use the material for what it covers.'
  );
}

/**
 * Material longer than the app keeps whole. It is still used — the lessons are written
 * from the parts that match them — but the learner is told what was left out rather than
 * finding out from a course that stops early.
 */
export function oversizeNote(materials: readonly StagedSource[]): string | null {
  const cut = materials.filter((m) => m.truncated);
  if (cut.length === 0) return null;
  const names = cut.map((m) => m.filename).join(', ');
  return (
    `${names} is longer than one course. We kept the first part of it and will write lessons ` +
    'from the sections that match them. Upload the chapters you actually need if you want all of it read.'
  );
}

/** No units anywhere is worth saying: it usually means the file was prose, not a syllabus. */
export function noUnitsNote(materials: readonly StagedSource[]): string | null {
  if (materials.length === 0) return null;
  if (materials.some((m) => m.units.length > 0)) return null;
  return (
    'We could not find a list of units in this. We will still use its wording and what it covers, ' +
    'but the order of the lessons will be ours.'
  );
}
