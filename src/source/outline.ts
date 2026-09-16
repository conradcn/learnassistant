// FRACTAL: implements F1, F2 | component C11
import type { Level, SourceUnit } from '@/shapes';

/**
 * What the material says about itself, read with rules rather than with a model.
 *
 * WHY no AI call here: this runs on the intake form while the learner waits, and it runs
 * before a provider has necessarily been configured at all. A syllabus states its own
 * scope in a shape that has barely changed in fifty years — a title, then a numbered list
 * of units — and a regular expression reads that in a millisecond, for free, offline, and
 * identically every time. The model gets the material later, where its judgement is worth
 * paying for: building the graph (F2). Everything here is a pre-fill the learner can
 * overrule, never a decision made on their behalf.
 */

export const MAX_UNITS = 60;

const UNIT_KEYWORD = /^(unit|module|week|chapter|topic|part|lesson|section|lecture)\s+([0-9]{1,3}|[ivxlc]{1,6}|[a-z])\b[.:)–-]*\s*(.*)$/i;
const MARKDOWN_HEADING = /^(#{1,4})\s+(.+?)\s*#*$/;
const NUMBERED = /^(\d{1,2}(?:\.\d{1,2})?)[.):]\s+(.{3,200})$/;

/** "Entropy .......... 42" and "Entropy    42" are a table of contents, not a title. */
function stripLeaders(title: string): string {
  return title
    .replace(/[.·\s]{4,}\d{1,4}\s*$/, '')
    .replace(/\s{2,}\d{1,4}\s*$/, '')
    .replace(/\s*[.,;:]\s*$/, '')
    .trim();
}

function usableTitle(raw: string): string | null {
  const title = stripLeaders(raw).slice(0, 300);
  if (title.length < 3) return null;
  if (!/[A-Za-z]/.test(title)) return null;
  return title;
}

/** A unit heading and the line it sits on, so the same boundaries that name the units
 *  also cut the document into sections for chunking. */
export type SourceSection = { label: string; title: string; line: number };

/**
 * Three shapes are recognised, and the STRONGEST one present wins outright rather than
 * being merged with the others: a syllabus that says "Week 1..12" also has markdown-ish
 * headings and stray numbered lines, and mixing all three produced a unit list longer
 * than the course. Keyword units beat headings beat bare numbering.
 */
export function sectionsOf(text: string): SourceSection[] {
  const keyword: SourceSection[] = [];
  const heading: SourceSection[] = [];
  const numbered: SourceSection[] = [];

  const lines = text.split('\n');
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.length > 300) return;

    const byKeyword = UNIT_KEYWORD.exec(trimmed);
    if (byKeyword !== null) {
      const label = `${byKeyword[1]} ${byKeyword[2]}`.replace(/\b\w/g, (c) => c.toUpperCase());
      const title = usableTitle(byKeyword[3]);
      // "Week 4" on its own is still a unit; it just has no title of its own yet.
      keyword.push({ label, title: title ?? label, line: index });
      return;
    }

    const byHeading = MARKDOWN_HEADING.exec(trimmed);
    if (byHeading !== null) {
      const title = usableTitle(byHeading[2]);
      if (title !== null) heading.push({ label: title, title, line: index });
      return;
    }

    const byNumber = NUMBERED.exec(trimmed);
    if (byNumber !== null) {
      const title = usableTitle(byNumber[2]);
      if (title !== null) numbered.push({ label: byNumber[1], title, line: index });
    }
  });

  return keyword.length >= 2 ? keyword : heading.length >= 2 ? heading : numbered;
}

/** The units the material names, in the order it names them. */
export function extractUnits(text: string): SourceUnit[] {
  const seen = new Set<string>();
  const out: SourceUnit[] = [];
  for (const section of sectionsOf(text)) {
    const key = section.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: section.label.slice(0, 60), title: section.title.slice(0, 300) });
    if (out.length >= MAX_UNITS) break;
  }
  return out;
}

const SUBJECT_LABEL = /^(course|subject|class|module)(\s+(title|name))?\s*[:–-]\s*(.{3,120})$/i;
const COURSE_CODE = /^[A-Z]{2,8}[\s-]?\d{1,4}[A-Z]?\s*[:.–-]\s*(.+)$/;
// The separator is optional AFTER the connecting word as well as instead of it:
// "Syllabus for: Topology" carries both, and leaving the colon on made it part of the
// subject we pre-filled the field with.
const NOISE_PREFIX = /^(syllabus|course outline|course syllabus|outline)\s*(?:(?:for|of)\b)?\s*[:–-]?\s*/i;
const NOISE_SUFFIX = /[\s–-]*(syllabus|course outline|course description|outline)\s*$/i;

function tidySubject(raw: string): string | null {
  let subject = raw.trim().replace(NOISE_PREFIX, '').replace(NOISE_SUFFIX, '').trim();
  const code = COURSE_CODE.exec(subject);
  // WHY the code is dropped: "PHYS 340" names a timetable slot at one institution. What
  // the learner is studying is the half after the colon, and that is what F2 researches.
  if (code !== null && code[1].trim().length >= 3) subject = code[1].trim();
  subject = subject.replace(/\s*[(\[].*?[)\]]\s*$/, '').replace(/[\s.,:;–-]+$/, '').trim();
  if (subject.length < 3 || subject.length > 200) return null;
  if (!/[A-Za-z]{3}/.test(subject)) return null;
  if (UNIT_KEYWORD.test(subject)) return null;
  return subject;
}

/**
 * The subject the material appears to be about. Pre-fills the intake field; the learner
 * corrects it if it is wrong, and correcting it is not a failure of anything.
 */
export function inferSubject(text: string): string | null {
  const lines = text
    .split(/\n|\f/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 60);

  for (const line of lines) {
    const labelled = SUBJECT_LABEL.exec(line);
    if (labelled !== null) {
      const subject = tidySubject(labelled[4]);
      if (subject !== null) return subject;
    }
  }

  for (const line of lines.slice(0, 12)) {
    if (line.length > 120) continue;
    if (/^(instructor|professor|lecturer|email|office|term|semester|credits?|prereq)/i.test(line)) continue;
    const subject = tidySubject(line.replace(/^#+\s*/, ''));
    if (subject !== null) return subject;
  }
  return null;
}

const LEVEL_MARKERS: { level: Level; patterns: RegExp[] }[] = [
  {
    level: 'advanced',
    patterns: [/\bgraduate\b/i, /\bph\.?d\b/i, /\bdoctoral\b/i, /\bqualifying exam\b/i, /\badvanced\b/i, /\bresearch seminar\b/i],
  },
  {
    level: 'beginner',
    patterns: [/\bintroduction to\b/i, /\bintroductory\b/i, /\bno prior\b/i, /\bfor beginners\b/i, /\bfirst course\b/i, /\bhigh school\b/i, /\bfrom scratch\b/i],
  },
  { level: 'intermediate', patterns: [/\bintermediate\b/i, /\bsecond course\b/i, /\bupper[- ]division\b/i] },
];

/**
 * The level the material reads as, when it says so plainly. Used ONLY to tell the learner
 * that their answer and their book disagree — the level they chose is still the level the
 * lessons are pitched at. A book is evidence about the material, not about the reader.
 */
export function detectLevelSignal(text: string): Level | null {
  const head = text.slice(0, 6000);
  let best: { level: Level; hits: number } | null = null;
  for (const marker of LEVEL_MARKERS) {
    const hits = marker.patterns.reduce((sum, re) => sum + (re.test(head) ? 1 : 0), 0);
    if (hits > 0 && (best === null || hits > best.hits)) best = { level: marker.level, hits };
  }
  return best === null ? null : best.level;
}

const STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'along', 'also', 'among', 'and', 'another', 'any', 'are',
  'because', 'been', 'before', 'being', 'between', 'both', 'but', 'course', 'each', 'either',
  'every', 'first', 'from', 'have', 'here', 'how', 'into', 'introduction', 'its', 'lecture',
  'lesson', 'more', 'most', 'must', 'not', 'other', 'over', 'part', 'reading', 'same', 'section',
  'should', 'some', 'student', 'students', 'such', 'syllabus', 'than', 'that', 'the', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'topic', 'topics', 'unit',
  'units', 'using', 'very', 'week', 'weeks', 'what', 'when', 'where', 'which', 'while', 'will',
  'with', 'within', 'without', 'your',
]);

/**
 * The words the material uses for its own ideas, most-load-bearing first. Handed to the
 * authoring sessions so a lesson says "state vector" where the book says "state vector",
 * rather than teaching the same idea under a name the learner will not meet again.
 */
export function keyTerms(text: string, units: SourceUnit[], limit = 30): string[] {
  const counts = new Map<string, number>();
  const bump = (word: string, weight: number): void => {
    const key = word.toLowerCase();
    if (key.length < 4 || key.length > 40) return;
    if (STOPWORDS.has(key)) return;
    if (!/^[a-z][a-z-]*$/.test(key)) return;
    counts.set(key, (counts.get(key) ?? 0) + weight);
  };

  // A word in a unit title is what the course calls its own subject matter, so it counts
  // for far more than the same word buried in an assessment policy.
  for (const unit of units) for (const word of unit.title.split(/[^A-Za-z-]+/)) bump(word, 8);
  for (const word of text.slice(0, 200_000).split(/[^A-Za-z-]+/)) bump(word, 1);

  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}
