// FRACTAL: covers F7, F5 | type unit
/**
 * F5 is explicit that progress is never expressed as a grade, and FSRS's stability,
 * difficulty and retrievability are exactly the numbers that grow a dashboard if they are
 * within reach of one. This asserts they are not.
 */
import { describe, expect, it } from 'vitest';
import { exampleReviewItem, reviewCueSchema } from '@/shapes';
import { toCue } from '@/review/cue';
import { toCard, dueLabel } from '@/ui/review-copy';

const FORBIDDEN = /stability|difficulty|retrievab|\bease\b|interval|lapse|reps|score|grade/i;

describe('F7 keeps the memory model out of the UI', () => {
  it('narrows a review item to when it is due and whether it is worth another look', () => {
    const cue = toCue(exampleReviewItem);

    expect(Object.keys(cue).sort()).toEqual(['dueAt', 'moduleId', 'needsAnotherLook']);
    expect(reviewCueSchema.safeParse(cue).success).toBe(true);
  });

  it('drops every memory-model field, whatever a ReviewItem gains later', () => {
    const cue = toCue(exampleReviewItem) as Record<string, unknown>;

    for (const key of Object.keys(cue)) {
      expect(key, `${key} names part of the memory model`).not.toMatch(FORBIDDEN);
    }
    expect(JSON.stringify(cue)).not.toContain(String(exampleReviewItem.memory.stability));
    expect(JSON.stringify(cue)).not.toContain(String(exampleReviewItem.memory.difficulty));
  });

  it('refuses a cue carrying extra fields, so a leak cannot pass validation', () => {
    const leaky = { ...toCue(exampleReviewItem), stability: 12.5 };
    expect(reviewCueSchema.safeParse(leaky).success).toBe(false);
  });

  it('says when to come back and never how well the learner did', () => {
    const cue = toCue(exampleReviewItem);
    const now = new Date(Date.parse(cue.dueAt) + 3 * 24 * 60 * 60 * 1000);

    const card = toCard(cue, 'Entropy as expected surprise', now);
    const strings = [card.title, card.dueLabel, dueLabel(cue, now)];

    for (const text of strings) {
      expect(text).not.toMatch(/\d+\s*%|stability|difficulty|score|grade|points?/i);
    }
    expect(card.dueLabel).toBe('waiting for 3 days');
    expect(card.needsAnotherLook).toBe(cue.needsAnotherLook);
  });
});
