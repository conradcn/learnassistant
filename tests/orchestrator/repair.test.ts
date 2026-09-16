// FRACTAL: covers F2 | type unit
import { describe, expect, it } from 'vitest';
import {
  exampleModuleContent,
  type LessonBlock,
  type ModuleGraph,
  type ModuleId,
  type ModuleNode,
  type TopicId,
} from '@/shapes';
import {
  MAX_PROSE_RUN,
  interleavingFindings,
  planRepairs,
  repairObjectives,
  repairTargets,
} from '@/orchestrator/repair';
import { REPAIR_TARGETS_PER_ROUND } from '@/orchestrator/repair.budget';

const TITLES = [
  'Decoding Dense Notation: Symbols, Indices, and Shapes',
  'Linear Algebra Refresher: Vector Spaces, Matrices as Maps, Rank',
  'Eigenvalues, SVD, and Low-Rank Structure',
  'Optimization Landscapes: Taylor, Convexity, and Descent',
];

function node(i: number, written: boolean): ModuleNode {
  return {
    id: `m_${'a'.repeat(14)}${i}` as ModuleId,
    topicId: 't_AAAAAAAAAAAAAAAA' as TopicId,
    title: TITLES[i - 1],
    ordinal: i,
    kind: 'module',
    testOutEligible: false,
    estimatedMinutes: 20,
    state: 'available',
    content: written ? exampleModuleContent : null,
  };
}

function graphOf(written = [1, 2, 3, 4]): ModuleGraph {
  const nodes = [1, 2, 3, 4].map((i) => node(i, written.includes(i)));
  return { topicId: 't_AAAAAAAAAAAAAAAA' as TopicId, nodes, edges: [], entryModules: [nodes[0].id] };
}

describe('routing a check finding to the lesson it is about', () => {
  it('prefers the ids the reviewer gave, when they are ids of this topic', () => {
    const graph = graphOf();
    expect(
      repairTargets(graph, { message: 'anything', affectedModules: [graph.nodes[2].id, graph.nodes[2].id] }),
    ).toEqual([graph.nodes[2].id]);
  });

  it('reads the ordinals out of the prose, because that is how the reviewer answers', () => {
    const graph = graphOf();
    expect(repairTargets(graph, { message: 'Lesson 4 needs a Hessian that lesson 3 never gives it.', affectedModules: [] })).toEqual([
      graph.nodes[2].id,
      graph.nodes[3].id,
    ]);
  });

  it('reads lesson titles too, and returns them in reading order', () => {
    const graph = graphOf();
    const finding = {
      message: `${TITLES[3]} leans on ${TITLES[1]} for rank.`,
      affectedModules: [] as ModuleId[],
    };
    expect(repairTargets(graph, finding)).toEqual([graph.nodes[1].id, graph.nodes[3].id]);
  });

  it('routes nothing when the finding names nothing — an unroutable finding is not a fix', () => {
    expect(repairTargets(graphOf(), { message: 'The whole thing feels uneven.', affectedModules: [] })).toEqual([]);
  });
});

describe('choosing what one repair round rewrites', () => {
  it('takes the most-complained-about lessons first, earliest lesson breaking a tie', () => {
    const graph = graphOf();
    const plans = planRepairs(graph, [
      { message: 'Lesson 4 is unmotivated.', affectedModules: [] },
      { message: 'Lesson 4 uses a symbol lesson 1 promised.', affectedModules: [] },
      { message: 'Lesson 2 defines rank twice.', affectedModules: [] },
      { message: 'Lesson 3 defers the determinant.', affectedModules: [] },
    ]);
    expect(plans.map((p) => p.node.ordinal)).toEqual([4, 1, 2]);
    expect(plans[0].findings).toHaveLength(2);
  });

  it('never plans more than a round is allowed to spend', () => {
    const findings = [1, 2, 3, 4].map((i) => ({ message: `Lesson ${i} is rough.`, affectedModules: [] }));
    expect(planRepairs(graphOf(), findings)).toHaveLength(REPAIR_TARGETS_PER_ROUND);
  });

  it('skips a lesson that was never written — that is the writing phase, not this one', () => {
    const plans = planRepairs(graphOf([1, 2]), [{ message: 'Lesson 4 is rough.', affectedModules: [] }]);
    expect(plans).toEqual([]);
  });
});

describe('what a repair session is told', () => {
  it('hands the session its own lesson and every finding against it, verbatim', () => {
    const objectives = repairObjectives(node(4, true), ['Lesson 4 has no Hessian.', 'Lesson 4 repeats lesson 3.']);
    expect(objectives.join('\n')).toContain('content.json');
    expect(objectives.join('\n')).toContain('Lesson 4 has no Hessian.');
    expect(objectives.join('\n')).toContain('Lesson 4 repeats lesson 3.');
    expect(objectives.join('\n')).toContain(TITLES[3]);
  });
});

const PROSE: LessonBlock = { kind: 'prose', markdown: 'Some words about the thing.' };
const FIGURE: LessonBlock = { kind: 'figure', svg: '<svg viewBox="0 0 1 1"></svg>', caption: 'A picture.' };

function withBlocks(i: number, blocks: LessonBlock[] | undefined): ModuleNode {
  const base = node(i, true);
  return { ...base, content: { ...exampleModuleContent, blocks } };
}

function graphOfNodes(nodes: ModuleNode[]): ModuleGraph {
  return { topicId: 't_AAAAAAAAAAAAAAAA' as TopicId, nodes, edges: [], entryModules: [nodes[0].id] };
}

describe('a lesson that breaks the interleaving contract is queued for repair, not shown', () => {
  it('queues a lesson whose body is missing entirely', () => {
    const missing = withBlocks(1, undefined);
    const graph = graphOfNodes([missing]);
    expect(interleavingFindings(graph).map((f) => f.affectedModules)).toEqual([[missing.id]]);
    expect(planRepairs(graph, interleavingFindings(graph)).map((p) => p.node.id)).toEqual([missing.id]);
  });

  it('queues a lesson whose body is an empty array', () => {
    const empty = withBlocks(2, []);
    expect(planRepairs(graphOfNodes([empty]), interleavingFindings(graphOfNodes([empty]))).map((p) => p.node.id)).toEqual([
      empty.id,
    ]);
  });

  it('queues a lesson that runs more prose blocks in a row than the contract allows', () => {
    const wall = withBlocks(3, [FIGURE, ...Array.from({ length: MAX_PROSE_RUN + 1 }, () => PROSE), FIGURE]);
    const graph = graphOfNodes([wall]);
    const findings = interleavingFindings(graph);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain(`${MAX_PROSE_RUN + 1} "prose" blocks in a row`);
    expect(planRepairs(graph, findings).map((p) => p.node.id)).toEqual([wall.id]);
  });

  it('leaves a lesson alone when it interleaves — the run is at the limit, not over it', () => {
    const ok = withBlocks(4, [...Array.from({ length: MAX_PROSE_RUN }, () => PROSE), FIGURE, PROSE]);
    expect(interleavingFindings(graphOfNodes([ok]))).toEqual([]);
    expect(planRepairs(graphOfNodes([ok]), [])).toEqual([]);
  });

  it('exempts the capstone, which is a brief for a piece of work and not a lesson to read', () => {
    const capstone = { ...withBlocks(1, undefined), kind: 'capstone' as const };
    expect(interleavingFindings(graphOfNodes([capstone]))).toEqual([]);
  });

  it('says nothing about a lesson that was never written', () => {
    expect(interleavingFindings(graphOfNodes([node(1, false)]))).toEqual([]);
  });
});
