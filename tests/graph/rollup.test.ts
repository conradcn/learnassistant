// FRACTAL: covers F5, F13 | type unit
import { describe, expect, it } from 'vitest';
import {
  exampleModuleGraph,
  exampleModuleNode,
  exampleTopicId,
  moduleIdSchema,
  topicStatusSchema,
  type ModuleGraph,
  type ModuleId,
  type ModuleNode,
} from '@/shapes';
import { completedSet } from '@/graph/availability';
import {
  progressCounts,
  progressCountsSchema,
  rollupFromCounts,
  topicRollup,
} from '@/graph/rollup';

function mid(n: number): ModuleId {
  return moduleIdSchema.parse(`m_${String(n).padStart(16, '0')}`);
}

function node(n: number, over: Partial<ModuleNode> = {}): ModuleNode {
  return { ...exampleModuleNode, id: mid(n), topicId: exampleTopicId, ordinal: n, title: `Module ${n}`, state: 'not-yet-recommended', ...over };
}

function graph(nodes: ModuleNode[], edges: { from: number; to: number }[] = []): ModuleGraph {
  return {
    ...exampleModuleGraph,
    topicId: exampleTopicId,
    nodes,
    edges: edges.map((e) => ({ from: mid(e.from), to: mid(e.to) })),
    entryModules: [],
  };
}

describe('topicRollup', () => {
  it('reports ready while any module is still open', () => {
    const g = graph([node(1, { state: 'completed' }), node(2)], [{ from: 1, to: 2 }]);
    expect(topicRollup(g, completedSet(g), 'not-started')).toBe('ready');
  });

  it('reports modules-complete when every module passed but the capstone is open (F5 AC)', () => {
    const g = graph([
      node(1, { state: 'completed' }),
      node(2, { state: 'assisted-pass' }),
      node(9, { kind: 'capstone', state: 'available' }),
    ]);
    expect(topicRollup(g, completedSet(g), 'not-started')).toBe('modules-complete');
    expect(topicRollup(g, completedSet(g), 'in-review')).toBe('modules-complete');
  });

  it('reports done only once the capstone passes (F13 gating)', () => {
    const g = graph([node(1, { state: 'completed' }), node(9, { kind: 'capstone', state: 'completed' })]);
    expect(topicRollup(g, completedSet(g), 'passed')).toBe('done');
  });

  it('never reports done while a module is still open, even with a passed capstone', () => {
    const g = graph([node(1, { state: 'completed' }), node(2)]);
    expect(topicRollup(g, completedSet(g), 'passed')).toBe('ready');
  });

  it('reports queued for a topic with no modules yet', () => {
    expect(topicRollup(graph([]), new Set(), 'n/a')).toBe('queued');
  });

  it('returns a value in the TopicStatus registry shape', () => {
    const g = graph([node(1, { state: 'completed' })]);
    expect(topicStatusSchema.safeParse(topicRollup(g, completedSet(g), 'n/a')).success).toBe(true);
  });
});

describe('rollupFromCounts', () => {
  it('preserves a stored generating or needs-attention status while modules are open', () => {
    expect(rollupFromCounts(12, 3, 'not-started', 'ready-with-notes')).toBe('ready-with-notes');
    expect(rollupFromCounts(12, 3, 'not-started', 'needs-attention')).toBe('needs-attention');
  });

  it('demotes a stale modules-complete row once a module reopens', () => {
    expect(rollupFromCounts(12, 11, 'not-started', 'modules-complete')).toBe('ready');
  });

  it('promotes to modules-complete and then done from the counts alone', () => {
    expect(rollupFromCounts(12, 12, 'in-review', 'ready')).toBe('modules-complete');
    expect(rollupFromCounts(12, 12, 'passed', 'ready')).toBe('done');
  });

  it('keeps the stored status for a topic that has no modules yet', () => {
    expect(rollupFromCounts(0, 0, 'n/a', 'generating')).toBe('generating');
  });
});

describe('progressCounts', () => {
  it('counts open and completed modules with no score-like aggregate', () => {
    const g = graph(
      [
        node(1, { state: 'completed' }),
        node(2, { state: 'assisted-pass' }),
        node(3),
        node(4),
        node(5, { state: 'needs-review' }),
        node(9, { kind: 'capstone' }),
      ],
      [{ from: 1, to: 3 }, { from: 3, to: 4 }],
    );
    const counts = progressCounts(g, completedSet(g));
    expect(progressCountsSchema.safeParse(counts).success).toBe(true);
    expect(counts).toEqual({
      completedCount: 2,
      availableCount: 1,
      remainingCount: 2,
      needsReviewCount: 1,
      assistedPassCount: 1,
    });
    expect(Object.keys(counts)).not.toContain('score');
  });

  it('reports a zero-progress topic as all remaining or available', () => {
    const g = graph([node(1), node(2)], [{ from: 1, to: 2 }]);
    const counts = progressCounts(g, new Set());
    expect(counts.completedCount).toBe(0);
    expect(counts.availableCount).toBe(1);
    expect(counts.remainingCount).toBe(1);
  });
});
