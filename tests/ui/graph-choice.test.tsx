// FRACTAL: covers F3, F5 | type unit
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ModuleAvailability, ModuleGraph, ModuleNode } from '@/shapes';
import { exampleModuleGraph, exampleModuleNode, moduleIdSchema } from '@/shapes';
import { GraphView } from '@/ui/components/GraphView';
import { graphLayout, resetGraphLayoutMemo } from '@/ui/graph-layout';

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

describe('the module graph as an open choice', () => {
  it('presents every open lesson side by side, with no implicit next', () => {
    render(<GraphView graph={graph} availability={availability} />);

    const open = screen.getAllByTestId('graph-open-node');
    expect(open).toHaveLength(2);
    expect(open.map((el) => el.textContent)).toEqual([
      expect.stringContaining('Prefix-free codes'),
      expect.stringContaining('Entropy as expected surprise'),
    ]);
    expect(screen.getByTestId('graph-view').getAttribute('data-open-choice')).toBe('yes');
    expect(screen.getByTestId('graph-choice-hint').textContent).toContain('whichever one interests you most');

    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/\bnext lesson\b/i);
    expect(screen.queryByRole('button', { name: /next/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /^next/i })).toBeNull();
  });

  it('gives each open lesson its own way in, so no alternative is hidden behind another', () => {
    render(<GraphView graph={graph} availability={availability} />);
    const links = screen.getAllByTestId('open-module') as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      `/modules/${ids.codes}`,
      `/modules/${ids.entropy}`,
    ]);
  });

  it('keeps done and later-on lessons in their own sections, still reachable', () => {
    render(<GraphView graph={graph} availability={availability} />);
    expect(screen.getAllByTestId('graph-done-node')).toHaveLength(1);
    const later = screen.getAllByTestId('graph-later-node');
    expect(later).toHaveLength(1);
    expect(later[0].textContent).toContain('Entropy as expected surprise');
    expect(screen.getByTestId('open-later-module').getAttribute('href')).toBe(`/modules/${ids.later}`);
    expect(later[0].textContent).toContain('Nothing stops you starting it now');
  });

  it('says so plainly when only one lesson is open, and never invents a choice', () => {
    const single = availability.map((a) =>
      a.moduleId === ids.entropy ? { ...a, state: 'not-yet-recommended' as const, unmetPrereqs: [ids.codes] } : a,
    );
    render(<GraphView graph={graph} availability={single} />);
    expect(screen.getAllByTestId('graph-open-node')).toHaveLength(1);
    expect(screen.getByTestId('graph-view').getAttribute('data-open-choice')).toBe('no');
    expect(screen.getByTestId('graph-choice-hint').textContent).toContain('One lesson is open');
  });

  it('offers the shortcut into the questions only where the plan says it makes sense', () => {
    const withTestOut: ModuleGraph = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === ids.codes ? { ...n, testOutEligible: true } : n)),
    };
    render(<GraphView graph={withTestOut} availability={availability} />);
    const shortcuts = screen.getAllByTestId('test-out-link') as HTMLAnchorElement[];
    expect(shortcuts).toHaveLength(1);
    expect(shortcuts[0].getAttribute('href')).toBe(`/modules/${ids.codes}/eval?mode=test-out`);
  });

  it('lays the graph out by depth and memoizes the walk per graph', () => {
    const first = graphLayout(graph, availability);
    const second = graphLayout(graph, availability);
    expect(second).toBe(first);
    expect(first.done[0].layer).toBe(0);
    expect(first.open[0].layer).toBe(1);
    expect(first.later[0].layer).toBe(2);
    expect(first.open[0].prereqTitles).toEqual(['Counting outcomes']);
    expect(first.later[0].unmetPrereqTitles).toEqual(['Entropy as expected surprise']);
    expect(first.isOpenChoice).toBe(true);
    expect(first.nodeCount).toBe(4);
  });
});
