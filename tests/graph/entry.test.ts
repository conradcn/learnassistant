// FRACTAL: covers F3 | type unit | path enter-past-advisory
import { describe, expect, it } from 'vitest';
import {
  exampleModuleGraph,
  exampleModuleNode,
  exampleTopicId,
  moduleIdSchema,
  type ModuleGraph,
  type ModuleId,
  type ModuleNode,
} from '@/shapes';
import { AppError } from '@/core/errors';
import { canEnter, canTestOut, entryDecisionSchema, hasNoOpenEntryModule } from '@/graph/entry';

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

const SHAPES: { name: string; g: ModuleGraph }[] = [
  { name: 'linear chain', g: graph([node(1), node(2), node(3)], [{ from: 1, to: 2 }, { from: 2, to: 3 }]) },
  { name: 'diamond', g: graph([node(1), node(2), node(3), node(4)], [{ from: 1, to: 2 }, { from: 1, to: 3 }, { from: 2, to: 4 }, { from: 3, to: 4 }]) },
  { name: 'disconnected', g: graph([node(1), node(2)], []) },
  { name: 'cyclic', g: graph([node(1), node(2)], [{ from: 1, to: 2 }, { from: 2, to: 1 }]) },
  { name: 'edges from a missing prerequisite', g: graph([node(1), node(2)], [{ from: 9, to: 1 }, { from: 9, to: 2 }]) },
];

describe('canEnter', () => {
  it.each(SHAPES)('never returns a non-enterable decision for a $name graph', ({ g }) => {
    for (const n of g.nodes) {
      const decision = canEnter(g, n.id, new Set());
      expect(decision.enterable).toBe(true);
      expect(entryDecisionSchema.safeParse(decision).success).toBe(true);
    }
  });

  it('carries an advisory naming every unmet prerequisite by title', () => {
    const g = graph([node(1, { title: 'Probability refresher' }), node(2)], [{ from: 1, to: 2 }]);
    const decision = canEnter(g, mid(2), new Set());
    expect(decision.enterable).toBe(true);
    expect(decision.advisory).not.toBeNull();
    expect(decision.advisory?.unmetPrereqs).toEqual([{ id: mid(1), title: 'Probability refresher' }]);
  });

  it('drops the advisory once the prerequisite is complete', () => {
    const g = graph([node(1), node(2)], [{ from: 1, to: 2 }]);
    expect(canEnter(g, mid(2), new Set<ModuleId>([mid(1)])).advisory).toBeNull();
  });

  it('leaves no graph shape without an entry module, and enters every node regardless', () => {
    for (const { g } of SHAPES) {
      expect(hasNoOpenEntryModule(g, new Set())).toBe(false);
      for (const n of g.nodes) {
        expect(canEnter(g, n.id, new Set()).enterable).toBe(true);
      }
    }
  });

  it('still enters every node of a fully-blocked graph past its advisory', () => {
    const g = graph([node(1), node(2)], [{ from: 1, to: 2 }, { from: 2, to: 1 }]);
    const blocked = canEnter(g, mid(2), new Set());
    expect(blocked.enterable).toBe(true);
    expect(blocked.advisory?.unmetPrereqs).toEqual([{ id: mid(1), title: 'Module 1' }]);
  });

  it('reports a graph whose every module is complete as not stuck', () => {
    const g = graph([node(1, { state: 'completed' })], []);
    expect(hasNoOpenEntryModule(g, new Set<ModuleId>([mid(1)]))).toBe(false);
  });

  it('raises a not-found AppError for a module outside the graph, leaking no internals', () => {
    const g = graph([node(1)], []);
    try {
      canEnter(g, mid(77), new Set());
      expect.unreachable('canEnter should reject an unknown module');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('not-found');
      expect((e as AppError).message).not.toContain('graph');
    }
  });
});

describe('canTestOut', () => {
  it('allows testing out of any module and highlights the flagged ones', () => {
    const g = graph([node(1, { testOutEligible: true }), node(2, { testOutEligible: false })], [{ from: 1, to: 2 }]);
    expect(canTestOut(g, mid(1))).toEqual({ allowed: true, highlighted: true });
    expect(canTestOut(g, mid(2))).toEqual({ allowed: true, highlighted: false });
  });

  it('rejects a module outside the graph', () => {
    expect(() => canTestOut(graph([node(1)], []), mid(5))).toThrow(AppError);
  });
});
