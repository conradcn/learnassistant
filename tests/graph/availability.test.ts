// FRACTAL: covers F3, F5 | type unit
import { describe, expect, it } from 'vitest';
import {
  exampleModuleGraph,
  exampleModuleNode,
  exampleTopicId,
  moduleIdSchema,
  type ModuleGraph,
  type ModuleId,
  type ModuleNode,
  type ModuleState,
} from '@/shapes';
import {
  availability,
  completedSet,
  graphDefects,
  moduleAvailabilitySchema,
  unlockedBy,
} from '@/graph/availability';

function mid(n: number): ModuleId {
  return moduleIdSchema.parse(`m_${String(n).padStart(16, '0')}`);
}

function node(n: number, over: Partial<ModuleNode> = {}): ModuleNode {
  return { ...exampleModuleNode, id: mid(n), topicId: exampleTopicId, ordinal: n, title: `Module ${n}`, state: 'not-yet-recommended', ...over };
}

function graph(nodes: ModuleNode[], edges: { from: number; to: number }[]): ModuleGraph {
  return {
    ...exampleModuleGraph,
    topicId: exampleTopicId,
    nodes,
    edges: edges.map((e) => ({ from: mid(e.from), to: mid(e.to) })),
    entryModules: [],
  };
}

describe('availability', () => {
  it('marks a zero-progress graph with two roots as two available modules (F3 >=2 available)', () => {
    const g = graph([node(1), node(2), node(3)], [
      { from: 1, to: 3 },
      { from: 2, to: 3 },
    ]);
    const rows = availability(g, new Set());
    const states = new Map(rows.map((r) => [r.moduleId, r.state] as const));
    expect(states.get(mid(1))).toBe('available');
    expect(states.get(mid(2))).toBe('available');
    expect(states.get(mid(3))).toBe('not-yet-recommended');
    expect(rows.find((r) => r.moduleId === mid(3))?.unmetPrereqs).toEqual([mid(1), mid(2)]);
  });

  it('produces rows that validate against the ModuleAvailability shape', () => {
    const g = graph([node(1), node(2)], [{ from: 1, to: 2 }]);
    for (const row of availability(g, new Set())) {
      expect(moduleAvailabilitySchema.safeParse(row).success).toBe(true);
    }
  });

  it('reports a mixed completed / available / remaining graph (F5 happy path)', () => {
    const g = graph(
      [node(1, { state: 'completed' }), node(2), node(3), node(4)],
      [
        { from: 1, to: 2 },
        { from: 2, to: 3 },
        { from: 3, to: 4 },
      ],
    );
    const completed = completedSet(g);
    expect(completed.has(mid(1))).toBe(true);
    const rows = availability(g, completed);
    const byId = new Map(rows.map((r) => [r.moduleId, r] as const));
    expect(byId.get(mid(1))?.state).toBe('completed');
    expect(byId.get(mid(2))?.state).toBe('available');
    expect(byId.get(mid(3))?.state).toBe('not-yet-recommended');
    expect(byId.get(mid(4))?.state).toBe('not-yet-recommended');
  });

  it('keeps an assisted-pass module counted as passed without downgrading its state', () => {
    const g = graph([node(1, { state: 'assisted-pass' }), node(2)], [{ from: 1, to: 2 }]);
    const rows = availability(g, completedSet(g));
    expect(rows[0].state).toBe('assisted-pass');
    expect(rows[1].state).toBe('available');
  });

  it('ignores back-edges of a cyclic graph so every module is still reachable', () => {
    const g = graph([node(1), node(2), node(3)], [
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 3, to: 1 },
    ]);
    const defects = graphDefects(g);
    expect(defects.backEdges).toHaveLength(1);
    const rows = availability(g, new Set());
    expect(rows.some((r) => r.state === 'available')).toBe(true);
    expect(rows.find((r) => r.moduleId === mid(1))?.unmetPrereqs).toEqual([]);
  });

  it('ignores an edge that references a missing module rather than blocking the dependent', () => {
    const g = graph([node(2)], [{ from: 99, to: 2 }]);
    const defects = graphDefects(g);
    expect(defects.missingPrereqEdges).toHaveLength(1);
    expect(availability(g, new Set())[0].state).toBe('available');
  });

  it('unlockedBy names exactly the modules whose last prerequisite the completion satisfies', () => {
    const g = graph([node(1, { state: 'completed' }), node(2), node(3), node(4)], [
      { from: 1, to: 3 },
      { from: 2, to: 3 },
      { from: 2, to: 4 },
    ]);
    const completed = new Set<ModuleId>([mid(1)]);
    expect(unlockedBy(g, mid(2), completed)).toEqual([mid(3), mid(4)]);
    expect(unlockedBy(g, mid(1), new Set())).toEqual([]);
  });

  it('returns no unlocks for a module that is not in the graph', () => {
    const g = graph([node(1)], []);
    expect(unlockedBy(g, mid(42), new Set())).toEqual([]);
  });

  it('reports zero progress as every root available and nothing completed', () => {
    const states: ModuleState[] = availability(graph([node(1), node(2)], []), new Set()).map((r) => r.state);
    expect(states).toEqual(['available', 'available']);
  });
});
