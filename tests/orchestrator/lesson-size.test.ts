// FRACTAL: covers F2 | type unit
import { describe, expect, it } from 'vitest';
import { isoDateStringSchema, topicIdSchema, type Topic } from '@/shapes';
import type { NewTopic } from '@/store/topics';
import { estimateModules, MAX_MODULE_MINUTES, MIN_MODULE_MINUTES, planFor } from '@/orchestrator/plan';
import { clampModuleMinutes, normalizeOutline, researchBrief } from '@/orchestrator/research';

const intake: NewTopic = {
  subject: 'Mathematics for reading frontier machine learning papers',
  level: 'intermediate',
  purpose: 'decode the equations in a paper instead of skipping over them',
  diagnostic: null,
};

const topic: Topic = {
  id: topicIdSchema.parse('t_9fQ2xK4mZa71bC0d'),
  subject: intake.subject,
  level: intake.level,
  purpose: intake.purpose,
  diagnostic: null,
  status: 'generating',
  drivingQuestion: null,
  notes: [],
  createdAt: isoDateStringSchema.parse('2026-08-28T00:00:00.000Z'),
  updatedAt: isoDateStringSchema.parse('2026-08-28T00:00:00.000Z'),
};

describe('a broad subject is split into more lessons, not wider ones', () => {
  it('spends breadth on module count', () => {
    // The same intake used to plan 12 modules; each then covered several topics.
    expect(estimateModules(intake)).toBeGreaterThan(12);
  });

  it('asks the outline for one idea per module, and says so in the brief', () => {
    const brief = researchBrief(topic, planFor(intake));
    expect(brief.targetMinutes).toBe(MAX_MODULE_MINUTES);
    expect(brief.moduleObjectives.join(' ')).toMatch(/ONE idea/);
    expect(brief.moduleObjectives.join(' ')).toMatch(/Split it into one per idea/);
  });
});

describe('an over-long module estimate is clamped, not trusted', () => {
  it('clamps out of range estimates and defaults a missing one', () => {
    expect(clampModuleMinutes(90)).toBe(MAX_MODULE_MINUTES);
    expect(clampModuleMinutes(1)).toBe(MIN_MODULE_MINUTES);
    expect(clampModuleMinutes(undefined)).toBe(MAX_MODULE_MINUTES);
    expect(clampModuleMinutes(15)).toBe(15);
  });

  it('never hands authoring a module bigger than one sitting', () => {
    const plan = planFor(intake);
    const outline = normalizeOutline(topic, plan, {
      modules: [
        { title: 'Everything about linear algebra', estimatedMinutes: 120 },
        { title: 'Everything about probability', estimatedMinutes: 75 },
      ],
      edges: [],
    });
    for (const m of outline.modules) {
      expect(m.estimatedMinutes).toBeLessThanOrEqual(MAX_MODULE_MINUTES);
    }
  });
});
