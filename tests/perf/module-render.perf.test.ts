// @vitest-environment jsdom
// FRACTAL: covers F3 | type unit
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ModuleAvailability, ModuleGraph, ModuleNode } from '@/shapes';
import {
  exampleModuleContent,
  exampleModuleGraph,
  exampleModuleNode,
  exampleReflection,
  moduleIdSchema,
} from '@/shapes';
import { GraphView } from '@/ui/components/GraphView';
import { LessonView } from '@/ui/components/LessonView';
import { graphLayoutWalks, resetGraphLayoutMemo } from '@/ui/graph-layout';
import { resetSanitizeMemo } from '@/ui/sanitize';
import { resetAppStore } from '@/ui/store';

const MODULES_PER_TOPIC = 12;
const SAMPLES = 30;
const WARM_UP_RUNS = 5;
const MODULE_RENDER_BUDGET_MS = 200;
const FIRST_PAINT_BUDGET_MS = 1500;

function moduleId(index: number): ModuleNode['id'] {
  return moduleIdSchema.parse(`m_${index.toString(16).padStart(16, '0')}`);
}

function paragraph(seed: number, line: number): string {
  return `Paragraph ${line} of lesson ${seed}: entropy is the expected number of yes/no questions, and **that** is the whole idea.`;
}

function lessonModule(seed: number): ModuleNode {
  const markdown = [`# Lesson ${seed}`, '', ...Array.from({ length: 40 }, (_v, i) => paragraph(seed, i)).flatMap((p) => [p, ''])].join('\n');
  return {
    ...exampleModuleNode,
    id: moduleId(seed),
    title: `Lesson ${seed}`,
    ordinal: seed,
    content: {
      ...exampleModuleContent,
      learningGoals: Array.from({ length: 6 }, (_v, i) => `Goal ${i} of lesson ${seed}`),
      explanation: { kind: 'text', markdown },
      visualization: {
        kind: 'svg',
        svg: `<svg viewBox="0 0 100 100">${Array.from({ length: 60 }, (_v, i) => `<circle cx="${i}" cy="${(i * seed) % 100}" r="2" />`).join('')}</svg>`,
        caption: `Picture for lesson ${seed}`,
      },
    },
  };
}

function topicGraph(): { graph: ModuleGraph; availability: ModuleAvailability[] } {
  const nodes = Array.from({ length: MODULES_PER_TOPIC }, (_v, i) => lessonModule(i + 1));
  const edges = nodes.slice(1).map((node, i) => ({ from: nodes[i].id, to: node.id }));
  const availability: ModuleAvailability[] = nodes.map((node, i) => ({
    moduleId: node.id,
    state: i < 4 ? ('completed' as const) : i < 7 ? ('available' as const) : ('not-yet-recommended' as const),
    unmetPrereqs: i < 7 ? [] : [nodes[i - 1].id],
  }));
  return {
    graph: { ...exampleModuleGraph, nodes, edges, entryModules: [nodes[0].id] },
    availability,
  };
}

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index];
}

function saveNote(): Promise<{ ok: true; data: typeof exampleReflection }> {
  return Promise.resolve({ ok: true, data: exampleReflection });
}

afterEach(() => {
  cleanup();
  resetGraphLayoutMemo();
  resetSanitizeMemo();
  resetAppStore();
});

describe('rendering at 12 lessons per subject', () => {
  it('paints one whole lesson well inside the budget', () => {
    const samples: number[] = [];
    for (let i = 0; i < SAMPLES + WARM_UP_RUNS; i += 1) {
      const node = lessonModule(i + 1);
      const started = performance.now();
      render(
        createElement(LessonView, {
          module: node,
          entry: { enterable: true, advisory: null },
          saveNote,
          contentIssue: null,
          onRetryAuthoring: (): void => undefined,
          onRemove: (): void => undefined,
        }),
      );
      fireEvent.click(screen.getByTestId('warm-up-skip'));
      expect(screen.getByTestId('explanation')).toBeTruthy();
      // WHY: the first few runs pay for module loading and JIT warm-up, which a learner
      // never pays per lesson; the budget is measured on the steady state.
      if (i >= WARM_UP_RUNS) samples.push(performance.now() - started);
      cleanup();
    }
    expect(samples).toHaveLength(SAMPLES);
    expect(percentile(samples, 0.95)).toBeLessThan(MODULE_RENDER_BUDGET_MS);
  });

  it('paints the whole subject graph well inside the first-paint budget', () => {
    const samples: number[] = [];
    for (let i = 0; i < SAMPLES + WARM_UP_RUNS; i += 1) {
      const { graph, availability } = topicGraph();
      resetGraphLayoutMemo();
      const started = performance.now();
      render(createElement(GraphView, { graph, availability }));
      if (i >= WARM_UP_RUNS) samples.push(performance.now() - started);
      cleanup();
    }
    expect(samples).toHaveLength(SAMPLES);
    expect(percentile(samples, 0.95)).toBeLessThan(FIRST_PAINT_BUDGET_MS);
  });

  it('does not re-walk the graph on a repeat render of the same subject', () => {
    const { graph, availability } = topicGraph();
    resetGraphLayoutMemo();

    // WHY the walk count rather than a stopwatch: comparing a warm render's duration
    // against a cold one asks two near-identical React renders to differ by more than
    // the noise between them, so the check passed or failed on luck and would have
    // stayed green with the memo deleted. The claim is that the edges are walked once;
    // that is what is asserted.
    for (let i = 0; i < SAMPLES; i += 1) {
      render(createElement(GraphView, { graph, availability }));
      cleanup();
    }
    expect(graphLayoutWalks()).toBe(1);

    // And the memo is genuinely doing it — cleared, the very next render walks again.
    resetGraphLayoutMemo();
    render(createElement(GraphView, { graph, availability }));
    cleanup();
    expect(graphLayoutWalks()).toBe(1);
  });
});
