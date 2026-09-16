// FRACTAL: covers F2 | type path | path graph-defect
import { describe, expect, it } from 'vitest';
import { moduleIdSchema, topicIdSchema, type ModuleGraph, type ModuleId, type ModuleNode } from '@/shapes';
import {
  entryModulesOf,
  findCycle,
  lowestConfidenceEdge,
  unreachableFrom,
  validateGraph,
} from '@/orchestrator/discontinuity';

const topicId = topicIdSchema.parse('t_9fQ2xK4mZa71bC0d');

function id(n: number): ModuleId {
  return moduleIdSchema.parse(`m_${String(n).padStart(16, '0')}`);
}

function node(n: number, title = `Lesson ${n}`): ModuleNode {
  return {
    id: id(n),
    topicId,
    title,
    ordinal: n,
    kind: 'module',
    testOutEligible: false,
    estimatedMinutes: 20,
    state: 'available',
    content: null,
  };
}

function graph(nodes: ModuleNode[], edges: { from: ModuleId; to: ModuleId }[]): ModuleGraph {
  return { topicId, nodes, edges, entryModules: [] };
}

describe('a cyclic proposal', () => {
  const g = graph(
    [node(1, 'Counting'), node(2, 'Probability'), node(3, 'Entropy')],
    [
      { from: id(1), to: id(2) },
      { from: id(2), to: id(3) },
      { from: id(3), to: id(1) },
    ],
  );

  it('detects the cycle before anything is accepted', () => {
    expect(findCycle(g.nodes, g.edges)).not.toBeNull();
  });

  it('drops the lowest-confidence edge — the one that points backwards through the outline', () => {
    const cycle = findCycle(g.nodes, g.edges);
    if (cycle === null) throw new Error('expected a cycle');
    expect(lowestConfidenceEdge(g, cycle)).toEqual({ from: id(3), to: id(1) });
  });

  it('breaks the cycle and names exactly which link was removed in a graph-defect note', () => {
    const { graph: fixed, validation } = validateGraph(g);
    expect(validation.acyclic).toBe(false);
    expect(findCycle(fixed.nodes, fixed.edges)).toBeNull();
    expect(fixed.edges).not.toContainEqual({ from: id(3), to: id(1) });
    expect(fixed.edges).toHaveLength(2);

    const defect = validation.issues.find((n) => n.kind === 'graph-defect');
    expect(defect).toBeDefined();
    expect(defect?.message).toContain('Counting');
    expect(defect?.message).toContain('Entropy');
    expect(defect?.affectedModules).toEqual([id(3), id(1)]);
  });

  it('is never silently accepted — a defect always produces a visible note', () => {
    expect(validateGraph(g).validation.issues.length).toBeGreaterThan(0);
  });
});

describe('at least one entry module', () => {
  it('finds the modules with no prerequisites', () => {
    const g = graph(
      [node(1), node(2), node(3)],
      [
        { from: id(1), to: id(2) },
        { from: id(1), to: id(3) },
      ],
    );
    expect(entryModulesOf(g.nodes, g.edges)).toEqual([id(1)]);
    expect(validateGraph(g).validation.entryModules).toEqual([id(1)]);
    expect(validateGraph(g).validation.issues).toEqual([]);
  });

  it('never leaves the learner with an empty available set when every node has a prerequisite', () => {
    const g = graph(
      [node(1), node(2)],
      [
        { from: id(1), to: id(2) },
        { from: id(2), to: id(1) },
      ],
    );
    const { validation } = validateGraph(g);
    expect(validation.entryModules.length).toBeGreaterThanOrEqual(1);
    const defects = validation.issues.filter((n) => n.kind === 'graph-defect');
    expect(defects.length).toBeGreaterThan(0);
  });
});

describe('unreachable nodes', () => {
  const g = graph(
    [node(1, 'Start'), node(2, 'Middle'), node(3, 'Island'), node(4, 'Also island')],
    [
      { from: id(1), to: id(2) },
      { from: id(3), to: id(4) },
      { from: id(4), to: id(3) },
    ],
  );

  it('detects nodes no entry module reaches', () => {
    expect(unreachableFrom(g.nodes, g.edges, [id(1)])).toEqual([id(3), id(4)]);
  });

  it('names them in a note and makes them directly enterable rather than stranding them', () => {
    const { graph: fixed, validation } = validateGraph(g);
    const note = validation.issues.find((n) => n.message.includes('could not be reached'));
    expect(note).toBeDefined();
    expect(note?.message).toContain('Island');
    expect(note?.affectedModules.length).toBeGreaterThan(0);
    for (const stranded of validation.unreachable) {
      expect(fixed.entryModules).toContain(stranded);
    }
  });
});

describe('a clean graph', () => {
  it('validates with no issues, and every node stays reachable', () => {
    const nodes = [node(1), node(2), node(3), node(4)];
    const g = graph(nodes, [
      { from: id(1), to: id(2) },
      { from: id(1), to: id(3) },
      { from: id(2), to: id(4) },
      { from: id(3), to: id(4) },
    ]);
    const { validation } = validateGraph(g);
    expect(validation).toEqual({ acyclic: true, entryModules: [id(1)], unreachable: [], issues: [] });
  });
});
