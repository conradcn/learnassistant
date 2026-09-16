// FRACTAL: covers F3, F5 | type unit
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ModuleAvailability, ModuleGraph, ModuleNode } from '@/shapes';
import { exampleModuleGraph, exampleModuleNode, moduleIdSchema } from '@/shapes';
import { GraphView } from '@/ui/components/GraphView';
import { fitScale, graphMap, worthDrawing, MAP_GEOMETRY, MIN_MAP_SCALE } from '@/ui/graph-map';
import { resetGraphLayoutMemo } from '@/ui/graph-layout';

const ids = {
  basics: exampleModuleNode.id,
  codes: moduleIdSchema.parse('m_0d9fQ2xK4mZa71bC'),
  entropy: moduleIdSchema.parse('m_1d9fQ2xK4mZa71bC'),
  later: moduleIdSchema.parse('m_2d9fQ2xK4mZa71bC'),
};

function node(id: ModuleNode['id'], title: string, state: ModuleNode['state'], ordinal: number): ModuleNode {
  return { ...exampleModuleNode, id, title, state, ordinal, content: null };
}

const graph: ModuleGraph = {
  ...exampleModuleGraph,
  nodes: [
    node(ids.basics, 'Counting outcomes', 'completed', 1),
    node(ids.codes, 'Prefix-free codes', 'available', 2),
    node(ids.entropy, 'Entropy as expected surprise', 'available', 3),
    node(ids.later, 'Channel capacity', 'not-yet-recommended', 4),
  ],
  edges: [
    { from: ids.basics, to: ids.codes },
    { from: ids.basics, to: ids.entropy },
    { from: ids.entropy, to: ids.later },
  ],
  entryModules: [ids.basics],
};

const availability: ModuleAvailability[] = [
  { moduleId: ids.basics, state: 'completed', unmetPrereqs: [] },
  { moduleId: ids.codes, state: 'available', unmetPrereqs: [] },
  { moduleId: ids.entropy, state: 'available', unmetPrereqs: [] },
  { moduleId: ids.later, state: 'not-yet-recommended', unmetPrereqs: [ids.entropy] },
];

afterEach(() => {
  cleanup();
  resetGraphLayoutMemo();
});

describe('the subject map geometry', () => {
  it('puts a lesson strictly below everything it grew out of', () => {
    const map = graphMap(graph, availability);
    const at = (id: ModuleNode['id']): number => {
      const found = map.nodes.find((n) => n.view.node.id === id);
      if (found === undefined) throw new Error('node missing from the map');
      return found.y;
    };
    expect(at(ids.basics)).toBeLessThan(at(ids.codes));
    expect(at(ids.basics)).toBeLessThan(at(ids.entropy));
    expect(at(ids.entropy)).toBeLessThan(at(ids.later));
    expect(at(ids.codes)).toBe(at(ids.entropy));
  });

  it('draws every prerequisite that runs downwards, and marks the ones not yet open', () => {
    const map = graphMap(graph, availability);
    expect(map.edges).toHaveLength(3);
    expect(map.edges.every((e) => e.path.startsWith('M '))).toBe(true);
    expect(map.edges.filter((e) => e.pending).map((e) => e.to)).toEqual([ids.later]);
  });

  it('keeps every box inside the picture it reports the size of', () => {
    const map = graphMap(graph, availability);
    const { nodeWidth, nodeHeight } = MAP_GEOMETRY;
    for (const n of map.nodes) {
      expect(n.x - nodeWidth / 2).toBeGreaterThanOrEqual(0);
      expect(n.x + nodeWidth / 2).toBeLessThanOrEqual(map.width);
      expect(n.y + nodeHeight / 2).toBeLessThanOrEqual(map.height);
    }
  });

  it('leaves the final project to its own card rather than drawing it twice', () => {
    const capstoneId = moduleIdSchema.parse('m_3d9fQ2xK4mZa71bC');
    const withCapstone: ModuleGraph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        { ...node(capstoneId, 'Project: build a compressor', 'not-yet-recommended', 5), kind: 'capstone' },
      ],
      edges: [...graph.edges, { from: ids.entropy, to: capstoneId }],
    };
    const map = graphMap(withCapstone, availability);
    expect(map.nodes.map((n) => n.view.node.id)).not.toContain(capstoneId);
    expect(map.edges.map((e) => e.to)).not.toContain(capstoneId);
  });

  it('declines to draw a picture that would teach nothing', () => {
    const flat: ModuleGraph = { ...graph, nodes: graph.nodes.slice(0, 2), edges: [] };
    expect(worthDrawing(graphMap(flat, []))).toBe(false);
    expect(worthDrawing(graphMap(graph, availability))).toBe(true);
  });

  it('survives a prerequisite cycle instead of looping forever', () => {
    const cyclic: ModuleGraph = {
      ...graph,
      edges: [...graph.edges, { from: ids.later, to: ids.basics }],
    };
    const map = graphMap(cyclic, availability);
    expect(map.nodes).toHaveLength(4);
  });
});

describe('the subject map on screen', () => {
  it('shows every lesson as a box that opens it, without inventing a next', () => {
    render(<GraphView graph={graph} availability={availability} />);
    const boxes = screen.getAllByTestId('graph-map-node');
    expect(boxes).toHaveLength(4);
    for (const box of boxes) {
      const link = box.querySelector('a');
      expect(link?.getAttribute('href')).toBe(`/modules/${box.getAttribute('data-module-id')}`);
    }
    expect(screen.getByTestId('graph-map-panel').textContent).toContain('grew out of');
  });

  it('groups the boxes the same way the lists below do', () => {
    render(<GraphView graph={graph} availability={availability} />);
    const groupOf = (id: string): string | null =>
      screen.getByTestId('graph-map').querySelector(`[data-module-id="${id}"]`)?.getAttribute('data-group') ?? null;
    expect(groupOf(ids.basics)).toBe('done');
    expect(groupOf(ids.codes)).toBe('open');
    expect(groupOf(ids.later)).toBe('later');
  });

  it('folds away without taking the lesson cards with it', () => {
    render(<GraphView graph={graph} availability={availability} />);
    fireEvent.click(screen.getByTestId('toggle-graph-map'));
    expect(screen.queryByTestId('graph-map')).toBeNull();
    expect(screen.getAllByTestId('graph-open-node')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('toggle-graph-map'));
    expect(screen.getByTestId('graph-map')).toBeTruthy();
  });
});

describe('fitting the map into the space there is', () => {
  const map = { nodes: [], edges: [], width: 800, height: 600, depth: 3 };

  it('shrinks to whichever side runs out first', () => {
    expect(fitScale(map, { width: 700, height: 6000 })).toBeCloseTo(0.875);
    expect(fitScale(map, { width: 8000, height: 480 })).toBeCloseTo(0.8);
    // Both are tight: the narrower of the two wins rather than the two compounding.
    expect(fitScale(map, { width: 700, height: 480 })).toBeCloseTo(0.8);
  });

  it('fits the widest realistic row inside the subject panel without scrolling', () => {
    // A layer six lessons across is the widest a generated course tends to get, and the
    // panel is ~870px inside a 940px page. That has to land above the readability floor,
    // or the common case is a map the learner has to drag sideways.
    const { nodeWidth, gapX, padding } = MAP_GEOMETRY;
    const sixWide = padding * 2 + 6 * nodeWidth + 5 * gapX;
    expect(fitScale({ ...map, width: sixWide }, { width: 870, height: 9999 })).toBeGreaterThan(
      MIN_MAP_SCALE,
    );
  });

  it('never enlarges a small course to fill a big screen', () => {
    expect(fitScale(map, { width: 4000, height: 4000 })).toBe(1);
  });

  it('stops shrinking before the titles stop being readable', () => {
    expect(fitScale(map, { width: 40, height: 40 })).toBe(MIN_MAP_SCALE);
  });

  it('draws at natural size until something has actually been measured', () => {
    expect(fitScale(map, { width: 0, height: 0 })).toBe(1);
    expect(fitScale({ ...map, width: 0, height: 0 }, { width: 500, height: 500 })).toBe(1);
  });
});
