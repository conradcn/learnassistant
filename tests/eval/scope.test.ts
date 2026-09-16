// FRACTAL: covers F4 | type unit
import { describe, expect, it } from 'vitest';
import { exampleModuleContent, type ModuleNode } from '@/shapes';
import { buildPrompt } from '@/cli/prompt';
import { briefFor, type TurnContext } from '@/eval/turn';
import { defaultScript } from '@/eval/session';
import { taughtScope } from '@/eval/scope';
import { reviewBrief } from '@/review/question';

const node = (content: ModuleNode['content']): ModuleNode => ({
  id: 'm_scopetest0000000000000' as ModuleNode['id'],
  topicId: 't_scopetest0000000000000' as ModuleNode['topicId'],
  title: 'Entropy as expected surprise',
  ordinal: 1,
  kind: 'module',
  testOutEligible: true,
  estimatedMinutes: 20,
  state: 'available',
  content,
});

const content: ModuleNode['content'] = {
  ...exampleModuleContent,
  learningGoals: ['State entropy as expected surprise'],
  explanation: { kind: 'text', markdown: 'Entropy measures how surprised you are on average.' },
  blocks: [
    { kind: 'prose', markdown: 'A fair coin costs one bit.' },
    { kind: 'figure', svg: '<svg viewBox="0 0 1 1"/>', caption: 'Surprise against probability' },
    {
      kind: 'check',
      question: 'How many yes/no questions pin down one of eight outcomes?',
      options: ['eight', 'three'],
      answerIndex: 1,
      whyRight: 'Each question halves the field.',
      whyWrong: 'Counting outcomes gives eight.',
    },
  ],
};

function ctxFor(n: ModuleNode | null): TurnContext {
  return {
    session: { id: 's_x' as never, moduleId: n?.id ?? ('m_x' as never), kind: 'module', turns: [], consecutiveFailures: 0, status: 'open', openedAt: '2026-01-01T00:00:00.000Z' as never },
    target: { kind: 'module', moduleId: (n?.id ?? 'm_x') as never },
    topic: { id: 't_x', subject: 'Information theory', level: 'intermediate', levelDetail: null, purpose: 'build a compressor', drivingQuestion: 'How small can a message get?', diagnostic: null } as never,
    topicB: null,
    graph: { topicId: 't_x' as never, nodes: n === null ? [] : [n], edges: [], entryModules: [] },
    node: n,
    script: defaultScript('Entropy as expected surprise'),
  };
}

describe('F4: the gate tests only what the lesson taught', () => {
  it('carries every taught line — prose, figure caption and check — into the scope', () => {
    const scope = taughtScope(node(content));
    expect(scope.join('\n')).toContain('A fair coin costs one bit.');
    expect(scope.join('\n')).toContain('Surprise against probability');
    expect(scope.join('\n')).toContain('pin down one of eight outcomes');
    expect(scope.join('\n')).toContain('State entropy as expected surprise');
    // The SVG markup is not teaching and must not be sent.
    expect(scope.join('\n')).not.toContain('<svg');
  });

  it('sends the lesson body and an in-scope-only instruction to the evaluator', () => {
    const brief = briefFor(ctxFor(node(content)), { text: 'Entropy is the average surprise.', selfAssessment: null });
    const { prompt } = buildPrompt({ kind: 'evaluate', brief });
    expect(prompt).toContain('A fair coin costs one bit.');
    expect(prompt).toContain('The lesson the learner studied, in reading order');
    expect(prompt).toContain('it is not on the test');
    expect(prompt).toContain('go deeper on this material');
  });

  it('says so plainly when there is no written lesson rather than sending an empty scope', () => {
    const brief = briefFor(ctxFor(node(null)), { text: 'hello', selfAssessment: null });
    expect(brief.taughtContent).toBeUndefined();
    expect(brief.moduleObjectives.join(' ')).toContain('no written lesson');
    const { prompt } = buildPrompt({ kind: 'evaluate', brief });
    expect(prompt).not.toContain('The lesson the learner studied');
  });
});

describe('F4/F7: the same bound applies everywhere a single lesson is gated', () => {
  it('leaves the capstone unbounded — it is judged against the whole subject', () => {
    const capstone = node(content);
    const brief = briefFor(
      { ...ctxFor(capstone), target: { kind: 'capstone', topicId: 't_x' as never } },
      { text: 'I built a Huffman coder.', selfAssessment: null },
    );
    expect(brief.taughtContent).toBeUndefined();
    expect(brief.moduleObjectives.join(' ')).not.toContain('it is not on the test');
  });
})

describe('F7: a review question is bounded by the lesson too', () => {
  it('sends the lesson body and the in-scope-only rule when generating the question', () => {
    const n = node(content);
    const brief = reviewBrief(
      { topic: ctxFor(n).topic, node: n, graph: ctxFor(n).graph } as never,
      defaultScript(n.title),
      null,
    );
    expect(brief.taughtContent?.join(' ')).toContain('A fair coin costs one bit.');
    expect(brief.moduleObjectives.join(' ')).toContain('it is not on the test');
    const { prompt } = buildPrompt({ kind: 'review-question', brief });
    expect(prompt).toContain('The lesson the learner studied, in reading order');
    expect(prompt).toContain('answerable');
  });
});
