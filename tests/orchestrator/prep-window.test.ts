// FRACTAL: covers F2 | type unit
import { describe, expect, it } from 'vitest';
import { exampleModuleContent, moduleIdSchema, topicIdSchema, type ModuleGraph, type ModuleNode } from '@/shapes';
import { deferredCount, MAX_PREP_MODULES, PREP_LOOKAHEAD_DEPTH, prepWindow } from '@/orchestrator/prep-window';
import { unpreparedAvailable } from '@/orchestrator/prepare-available';

const topicId = topicIdSchema.parse('t_9fQ2xK4mZa71bC0d');

function id(n: number): ModuleNode['id'] {
  return moduleIdSchema.parse(`m_${String(n).padStart(16, '0')}`);
}

function node(n: number, written = false): ModuleNode {
  return {
    id: id(n),
    topicId,
    title: `Lesson ${n}`,
    ordinal: n,
    kind: 'module',
    testOutEligible: false,
    estimatedMinutes: 20,
    state: 'available',
    content: written ? exampleModuleContent : null,
  };
}

function chain(count: number, written: number[] = []): ModuleGraph {
  const nodes = Array.from({ length: count }, (_v, i) => node(i, written.includes(i)));
  return {
    topicId,
    nodes,
    edges: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id })),
    entryModules: [nodes[0].id],
  };
}

function wide(count: number): ModuleGraph {
  const nodes = Array.from({ length: count }, (_v, i) => node(i));
  return {
    topicId,
    nodes,
    edges: nodes.slice(1).map((n) => ({ from: nodes[0].id, to: n.id })),
    entryModules: [nodes[0].id],
  };
}

describe('a course longer than the window is prepared a pass at a time', () => {
  it('writes a course that fits in one window all at once', () => {
    const graph = chain(4);
    expect(prepWindow(graph)).toHaveLength(Math.min(4, PREP_LOOKAHEAD_DEPTH));
    expect(prepWindow(wide(6))).toHaveLength(6);
    expect(deferredCount(wide(6))).toBe(0);
  });

  it('caps a wide graph by count, where depth alone would prepare the whole degree', () => {
    const graph = wide(40);
    expect(prepWindow(graph)).toHaveLength(MAX_PREP_MODULES);
    expect(deferredCount(graph)).toBe(40 - MAX_PREP_MODULES);
  });

  it('caps a deep graph by lookahead, where the count alone would run far ahead', () => {
    const graph = chain(40);
    const window = prepWindow(graph);
    expect(window).toHaveLength(PREP_LOOKAHEAD_DEPTH);
    expect(window.map((n) => n.ordinal)).toEqual([0, 1]);
  });

  it('slides forward as lessons land, so the next pass writes the next lessons', () => {
    const graph = chain(40, [0, 1, 2]);
    expect(prepWindow(graph).map((n) => n.ordinal)).toEqual([3, 4]);
  });

  it('never re-prepares a lesson that is already written', () => {
    const graph = wide(40);
    const first = prepWindow(graph).map((n) => n.id);
    const after: ModuleGraph = {
      ...graph,
      nodes: graph.nodes.map((n) => (first.includes(n.id) ? { ...n, content: exampleModuleContent } : n)),
    };
    for (const n of prepWindow(after)) expect(first).not.toContain(n.id);
  });

  it('leaves the capstone to its own action', () => {
    const graph = wide(3);
    const withCapstone: ModuleGraph = {
      ...graph,
      nodes: [...graph.nodes, { ...node(99), kind: 'capstone', state: 'not-yet-recommended' }],
    };
    expect(prepWindow(withCapstone).some((n) => n.kind === 'capstone')).toBe(false);
  });
});

describe('F2: the lessons the learner can start now are the ones a pass writes', () => {
  /**
   * A course whose first lesson has been passed, unlocking a lesson late in the ordinal
   * order, while everything else is locked behind lessons nobody has passed. Every
   * unwritten lesson here is at unwritten-depth 0, so before availability was part of the
   * ordering the window was filled by ordinal and the one lesson the learner could
   * actually open was the one left out — every five minutes, forever.
   */
  function starving(): ModuleGraph {
    const entry = { ...node(0, true), state: 'completed' as const };
    const gate = { ...node(1, true), state: 'available' as const };
    const locked = Array.from({ length: MAX_PREP_MODULES + 2 }, (_v, i) => node(i + 2));
    const unlocked = node(MAX_PREP_MODULES + 40);
    const nodes = [entry, gate, ...locked, unlocked];
    return {
      topicId,
      nodes,
      edges: [
        { from: entry.id, to: unlocked.id },
        ...locked.map((n) => ({ from: gate.id, to: n.id })),
      ],
      entryModules: [entry.id],
    };
  }

  it('writes the unlocked lesson rather than filling the window with locked ones', () => {
    const graph = starving();
    const available = unpreparedAvailable(graph).map((n) => n.id);
    expect(available).toHaveLength(1);
    expect(prepWindow(graph).map((n) => n.id)).toContain(available[0]);
    // And it goes first: it is the lesson the learner is waiting on.
    expect(prepWindow(graph)[0].id).toBe(available[0]);
  });

  it('still fills the rest of the window with the lookahead, and still caps it', () => {
    expect(prepWindow(starving())).toHaveLength(MAX_PREP_MODULES);
  });
});
