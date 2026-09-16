// FRACTAL: covers F2 | type unit | path which-step-is-the-subject-waiting-on
import { describe, expect, it } from 'vitest';
import type { ModuleGraph, ModuleNode, TopicNote, TopicStatus } from '@/shapes';
import { exampleModuleContent, exampleModuleNode, isoDateStringSchema } from '@/shapes';
import { extensionLine, generationFailed, planStep, planningPanel, writingMore } from '@/ui/plan-card';

const empty: ModuleGraph = { topicId: exampleModuleNode.topicId, nodes: [], edges: [], entryModules: [] };

function graphOf(...nodes: ModuleNode[]): ModuleGraph {
  return { ...empty, nodes };
}

const unwrittenNode: ModuleNode = { ...exampleModuleNode, content: null };
const writtenNode: ModuleNode = { ...exampleModuleNode, content: exampleModuleContent };

describe('F2: the door onto each authorised step', () => {
  it('offers planning to a subject that has no outline at all', () => {
    // The regression: `unwritten` is 0 here because nothing is planned, not because
    // everything is written, and that read as "no action left".
    expect(planStep('needs-attention', empty, 0)).toBe('plan');
  });

  it('offers writing once the outline exists but the lessons do not', () => {
    expect(planStep('needs-attention', graphOf(unwrittenNode), 1)).toBe('write');
  });

  it('offers nothing once every lesson is written', () => {
    expect(planStep('ready', graphOf(writtenNode), 0)).toBeNull();
  });

  it('offers nothing while planning is actually under way', () => {
    for (const status of ['queued', 'generating'] satisfies TopicStatus[]) {
      expect(planStep(status, empty, 0)).toBeNull();
      expect(planStep(status, graphOf(unwrittenNode), 1)).toBeNull();
    }
  });
});

describe('F2: what the screen shows while work is running', () => {
  it('gives the whole screen to the planning panel only when nothing is planned yet', () => {
    expect(planningPanel('generating', empty)).toBe(true);
    expect(planningPanel('queued', empty)).toBe(true);
    expect(planningPanel('ready', empty)).toBe(false);
  });

  it('keeps the lessons on screen while a later pass writes the next batch', () => {
    // The regression: pressing the button that says "this writes the next 10, so you can
    // start while the rest wait" replaced the graph with "Planning your lessons…", hiding
    // every lesson the learner already had.
    const started = graphOf(writtenNode, unwrittenNode);
    expect(planningPanel('generating', started)).toBe(false);
    expect(writingMore('generating', started)).toBe(true);
    expect(writingMore('generating', empty)).toBe(false);
    expect(writingMore('ready', started)).toBe(false);
  });
});

describe('F2: a run that stopped before it finished', () => {
  const note = (kind: TopicNote['kind']): TopicNote => ({
    kind,
    message: 'Something to say about this subject.',
    affectedModules: [],
    createdAt: isoDateStringSchema.parse('2026-08-22T09:20:00.000Z'),
  });

  it('is the status and the note together, never the status alone', () => {
    // The regression this guards: `needs-attention` is ALSO how a healthy research pass
    // hands the subject back, so reading the status by itself dressed up "press the next
    // button" as a crash.
    expect(generationFailed('needs-attention', [note('generation-failure')])).toBe(true);
    expect(generationFailed('needs-attention', [])).toBe(false);
    expect(generationFailed('needs-attention', [note('discontinuity')])).toBe(false);
  });

  it('is never claimed of a subject that is still working or already finished', () => {
    for (const status of ['queued', 'generating', 'ready', 'done'] satisfies TopicStatus[]) {
      expect(generationFailed(status, [note('generation-failure')])).toBe(false);
    }
  });
});

describe('F12: what the page says about a goal this subject has been carried to', () => {
  const at = isoDateStringSchema.parse('2026-09-01T10:00:00.000Z');

  it('names the goal and the lessons it added', () => {
    expect(extensionLine({ goal: 'Sufficient knowledge for the MCAT', modulesAdded: 12, createdAt: at })).toBe(
      'Sufficient knowledge for the MCAT — 12 lessons added',
    );
    expect(extensionLine({ goal: 'One more chapter', modulesAdded: 1, createdAt: at })).toContain('1 lesson added');
  });

  it('says a request that has not been planned yet is still being worked out, not that it added nothing', () => {
    const line = extensionLine({ goal: 'Sufficient knowledge for the MCAT', modulesAdded: 0, createdAt: at });
    expect(line).toContain('being worked out now');
    expect(line).not.toContain('0 lesson');
  });
});
