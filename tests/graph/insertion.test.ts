// FRACTAL: covers F12 | type unit
import { describe, expect, it } from 'vitest';
import {
  exampleModuleGraph,
  exampleModuleNode,
  exampleTopicId,
  moduleIdSchema,
  topicIdSchema,
  type ModuleGraph,
  type ModuleId,
  type ModuleNode,
  type PrereqEdge,
} from '@/shapes';
import { insertionCheckSchema, validateInsertion } from '@/graph/insertion';

function mid(n: number): ModuleId {
  return moduleIdSchema.parse(`m_${String(n).padStart(16, '0')}`);
}

function node(n: number, over: Partial<ModuleNode> = {}): ModuleNode {
  return { ...exampleModuleNode, id: mid(n), topicId: exampleTopicId, ordinal: n, title: `Module ${n}`, state: 'not-yet-recommended', ...over };
}

function edge(from: number, to: number): PrereqEdge {
  return { from: mid(from), to: mid(to) };
}

const base: ModuleGraph = {
  ...exampleModuleGraph,
  topicId: exampleTopicId,
  nodes: [node(1, { state: 'completed' }), node(2), node(3)],
  edges: [edge(1, 2), edge(2, 3)],
  entryModules: [mid(1)],
};

const detour = node(50, { kind: 'detour', title: 'Detour: measure zero' });

describe('validateInsertion', () => {
  it('accepts a detour hung off an existing module', () => {
    const check = validateInsertion(base, detour, [edge(2, 50)]);
    expect(check).toEqual({ ok: true });
    expect(insertionCheckSchema.safeParse(check).success).toBe(true);
  });

  it('accepts a detour with no prerequisite edges at all', () => {
    expect(validateInsertion(base, detour, [])).toEqual({ ok: true });
  });

  it('rejects a detour that would become a prerequisite of an existing module', () => {
    const check = validateInsertion(base, detour, [edge(50, 3)]);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toBe('prereq-of-existing');
    expect(check.detail).toContain('Module 3');
    expect(insertionCheckSchema.safeParse(check).success).toBe(true);
  });

  it('rejects an insertion that would create a cycle', () => {
    const check = validateInsertion(base, detour, [edge(3, 50), edge(50, 2)]);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toBe('would-create-cycle');
    expect(check.detail.length).toBeGreaterThan(0);
  });

  it('rejects an edge anchored to a module that is not in the topic', () => {
    const check = validateInsertion(base, detour, [edge(99, 50)]);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toBe('unknown-anchor');
  });

  it('rejects an edge that does not touch the new module', () => {
    const check = validateInsertion(base, detour, [edge(1, 3)]);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toBe('unknown-anchor');
  });

  it('rejects a node that belongs to another topic', () => {
    const foreign = { ...detour, topicId: topicIdSchema.parse('t_0d9fQ2xK4mZa71bC') };
    const check = validateInsertion(base, foreign, []);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toBe('unknown-anchor');
  });

  it('rejects re-inserting a module that already exists in the topic', () => {
    const check = validateInsertion(base, node(2), []);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toBe('unknown-anchor');
    expect(check.detail).toContain('already');
  });

  it('leaves already-completed modules untouched by a valid insertion', () => {
    expect(validateInsertion(base, detour, [edge(1, 50)])).toEqual({ ok: true });
    expect(base.nodes[0].state).toBe('completed');
  });
});
