// FRACTAL: covers F1, F2 | type unit
import { describe, expect, it } from 'vitest';
import { detectLevelSignal, extractUnits, inferSubject, keyTerms, sectionsOf } from '@/source/outline';
import { normalizeSourceText } from '@/source/text';

const WEEKLY_SYLLABUS = [
  'PHYS 340: Statistical Mechanics',
  'Autumn term. Instructor: someone.',
  '',
  'Week 1: Microstates and macrostates',
  'Reading: chapter 1.',
  'Week 2: The Boltzmann distribution',
  'Week 3: Partition functions',
  'Week 4: Free energy',
].join('\n');

describe('what the material says about itself', () => {
  it('reads the units a syllabus names, in the order it names them', () => {
    const units = extractUnits(WEEKLY_SYLLABUS);
    expect(units.map((u) => u.title)).toEqual([
      'Microstates and macrostates',
      'The Boltzmann distribution',
      'Partition functions',
      'Free energy',
    ]);
    expect(units[0].label).toBe('Week 1');
  });

  it('takes the strongest heading shape outright rather than merging all three', () => {
    // This document has weeks AND markdown headings AND numbered lines. Merging them
    // produced a unit list longer than the course it describes.
    const mixed = [
      '# Course outline',
      'Week 1: Vectors',
      '## Notes for week 1',
      '1. Read the chapter',
      'Week 2: Matrices',
      '## Notes for week 2',
      '2. Do the problems',
    ].join('\n');
    expect(extractUnits(mixed).map((u) => u.title)).toEqual(['Vectors', 'Matrices']);
  });

  it('falls back to headings, then to bare numbering, when no unit keyword is used', () => {
    const headings = ['# Linear maps', 'some prose', '## Eigenvalues', 'more prose'].join('\n');
    expect(extractUnits(headings).map((u) => u.title)).toEqual(['Linear maps', 'Eigenvalues']);

    const numbered = ['1. Limits and continuity', 'prose', '2. The derivative', 'prose'].join('\n');
    expect(extractUnits(numbered).map((u) => u.title)).toEqual([
      'Limits and continuity',
      'The derivative',
    ]);
  });

  it('strips table-of-contents leaders, so a page number is not part of a title', () => {
    const toc = ['Chapter 1: Entropy .......... 14', 'Chapter 2: Coding    37'].join('\n');
    expect(extractUnits(toc).map((u) => u.title)).toEqual(['Entropy', 'Coding']);
  });

  it('keeps a bare unit heading as a unit, using its own label as the title', () => {
    const bare = ['Unit 1', 'prose about the first idea', 'Unit 2', 'prose about the second'].join('\n');
    expect(extractUnits(bare).map((u) => u.title)).toEqual(['Unit 1', 'Unit 2']);
  });

  it('drops a repeated title, because a syllabus that lists its weeks twice has one course', () => {
    const repeated = ['Week 1: Vectors', 'Week 2: Matrices', 'Week 1: Vectors'].join('\n');
    expect(extractUnits(repeated)).toHaveLength(2);
  });

  it('records the line each unit sits on, so the same boundaries can cut the document', () => {
    const sections = sectionsOf(WEEKLY_SYLLABUS);
    expect(sections.map((s) => s.line)).toEqual([3, 5, 6, 7]);
  });

  it('finds no units in prose that names none', () => {
    expect(extractUnits('A paragraph about thermodynamics. Then another one.')).toEqual([]);
  });
});

describe('the subject the material appears to be about', () => {
  it('drops a course code, keeping what is actually being studied', () => {
    // "PHYS 340" names a timetable slot at one institution; the subject is the other half.
    expect(inferSubject(WEEKLY_SYLLABUS)).toBe('Statistical Mechanics');
  });

  it('prefers a line that labels itself over the first line on the page', () => {
    const labelled = [
      'Department of Mathematics',
      'Spring 2026',
      'Course: Measure theory and integration',
    ].join('\n');
    expect(inferSubject(labelled)).toBe('Measure theory and integration');
  });

  it('strips the noise around a title rather than making it part of the subject', () => {
    expect(inferSubject('Syllabus for: Introduction to Topology')).toBe('Introduction to Topology');
    // Everything here reads text that has already been through `normalizeSourceText`,
    // which is where a typographic dash becomes a hyphen — so that is what is asserted.
    expect(inferSubject(normalizeSourceText('Real Analysis — Course Outline'))).toBe('Real Analysis');
  });

  it('skips administrative lines that are never the subject', () => {
    const admin = ['Instructor: Dr Someone', 'Office: room 4', 'Graph theory'].join('\n');
    expect(inferSubject(admin)).toBe('Graph theory');
  });

  it('returns null rather than guessing when nothing reads as a title', () => {
    expect(inferSubject('   \n123\n456\n')).toBeNull();
  });

  it('never returns a unit heading as the subject of the course', () => {
    expect(inferSubject('Week 1: Vectors\nWeek 2: Matrices')).toBeNull();
  });
});

describe('the level the material reads as', () => {
  it('reads a stated level, and only when it is stated plainly', () => {
    expect(detectLevelSignal('A graduate seminar in algebraic topology.')).toBe('advanced');
    expect(detectLevelSignal('Introduction to statistics. No prior experience needed.')).toBe('beginner');
    expect(detectLevelSignal('An upper-division course.')).toBe('intermediate');
    expect(detectLevelSignal('Statistical mechanics. We meet on Tuesdays.')).toBeNull();
  });

  it('only reads the opening of the document, not a stray word on page 400', () => {
    const long = `${'Ordinary prose about the subject. '.repeat(400)}\nA graduate seminar.`;
    expect(detectLevelSignal(long)).toBeNull();
  });
});

describe('the words the material uses for its own ideas', () => {
  it('weights a word in a unit title far above the same word buried in the prose', () => {
    const text = [
      'Week 1: Entropy and mutual information',
      'Administrative policy paragraph. Policy, policy, policy, policy, policy, policy.',
      'Week 2: Channel capacity',
      'Entropy appears here once more.',
    ].join('\n');
    const terms = keyTerms(text, extractUnits(text));
    expect(terms).toContain('entropy');
    expect(terms.indexOf('entropy')).toBeLessThan(terms.indexOf('policy'));
  });

  it('leaves out syllabus furniture, so the vocabulary is the subject and not the form', () => {
    const terms = keyTerms(WEEKLY_SYLLABUS, extractUnits(WEEKLY_SYLLABUS));
    for (const stopword of ['week', 'reading', 'syllabus', 'course', 'topic']) {
      expect(terms).not.toContain(stopword);
    }
  });

  it('honours the limit it is given', () => {
    const text = extractUnits(WEEKLY_SYLLABUS);
    expect(keyTerms(WEEKLY_SYLLABUS, text, 3).length).toBeLessThanOrEqual(3);
  });
});
