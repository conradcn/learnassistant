// FRACTAL: covers F2 | type unit | path invalid-content-is-diagnosable
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { contractIssuesOf } from '@/orchestrator/content-validate';
import { scrub } from '@/core/scrub';

/**
 * WHY: an authoring session that answers but fails the content check is the one failure the
 * learner is charged for and nobody can explain. The record has to name the field that was
 * wrong — and must not buy that by copying the lesson into the log.
 */
describe('what a rejected lesson leaves behind', () => {
  const schema = z.object({
    title: z.string(),
    blocks: z.array(z.object({ markdown: z.string() })),
  });

  function issuesFor(value: unknown): string[] {
    const parsed = schema.safeParse(value);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('expected a failure to describe');
    return contractIssuesOf(parsed.error);
  }

  it('names the field that was wrong and how', () => {
    const issues = issuesFor({ blocks: [{ markdown: 'fine' }] });
    expect(issues).toContain('title:invalid_type');
  });

  it('points at the offending element of a list, not just the list', () => {
    const issues = issuesFor({ title: 'A', blocks: [{ markdown: 'fine' }, { markdown: 42 }] });
    expect(issues).toContain('blocks.1.markdown:invalid_type');
  });

  it('carries no scrap of the text the model wrote', () => {
    const secret = 'the learner asked about their own medical history';
    const issues = issuesFor({ title: secret, blocks: secret });
    expect(issues.join(' ')).not.toContain(secret);
  });

  it('survives the log scrubber, which is the only reason it is worth recording', () => {
    const issues = issuesFor({ blocks: [{ markdown: 'fine' }] });
    const scrubbed = scrub({ event: 'content-validation-failed', contractIssues: issues }) as {
      contractIssues: string[];
    };
    expect(scrubbed.contractIssues).toEqual(issues);
  });

  it('stays bounded when a whole lesson is malformed', () => {
    const many = z.object(Object.fromEntries(Array.from({ length: 40 }, (_v, i) => [`f${i}`, z.string()])));
    const parsed = many.safeParse({});
    if (parsed.success) throw new Error('expected a failure to describe');
    expect(contractIssuesOf(parsed.error).length).toBeLessThanOrEqual(12);
  });
});
