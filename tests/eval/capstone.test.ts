// FRACTAL: covers F13 | type integration
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exampleEvalVerdict, type ModuleNode } from '@/shapes';
import { canEnter } from '@/graph/entry';
import { completedSet } from '@/graph/availability';
import { purposeIsBuildable, synthesisSpec } from '@/orchestrator/capstone-spec';
import { artifactIsReviewable, capstoneRecord, capstoneRounds } from '@/eval/capstone';
import { sessionIdFor } from '@/eval/session';
import { bootHarness, evaluatorOutput, seedTopic, type Harness } from '@/eval/harness.testing';

const ARTIFACT = 'A Huffman coder in 120 lines, plus notes on why I chose a priority queue over sorting.';
const REVISED = `${ARTIFACT} Revised: I now measure compression ratio against a fixed corpus and report it.`;

let h: Harness;

beforeEach(() => {
  h = bootHarness();
});

afterEach(async () => {
  await h.teardown();
});

function passVerdict(): typeof exampleEvalVerdict {
  return { ...exampleEvalVerdict, outcome: 'pass', assistLevel: 0 };
}

describe('F13 happy path: build, submit, pass', () => {
  it('reviews the submitted work and only then lets the topic be done', async () => {
    const { topic, nodes } = seedTopic(h.store, { withCapstone: true });
    const modules = nodes.filter((n) => n.kind !== 'capstone');
    const capstone = nodes[nodes.length - 1];

    for (const m of modules) h.store.completeModule(m.id, passVerdict());
    expect(h.engine.topicIsDone(topic.id)).toBe(false);

    h.respondWith(() =>
      evaluatorOutput({ reply: 'The work stands up. Good.', mode: 'verdict', outcome: 'pass' }),
    );
    const result = await h.engine.submitCapstone(topic.id, ARTIFACT);

    expect(result.verdict.outcome).toBe('pass');
    expect(result.completion?.moduleId).toBe(capstone.id);
    expect(h.engine.topicIsDone(topic.id)).toBe(true);

    const record = capstoneRecord(topic, h.store.modules.graph(topic.id), h.store.evals.get(sessionIdFor('capstone', { kind: 'capstone', topicId: topic.id })));
    expect(record?.status).toBe('passed');
    expect(record?.drivingQuestionRef).toBe(topic.drivingQuestion ?? '');
    expect(record?.purposeRef).toBe(topic.purpose);
  });

  it('judges the artefact, refusing a submission with nothing in it to judge', async () => {
    const { topic } = seedTopic(h.store, { withCapstone: true });
    expect(artifactIsReviewable('done')).toBe(false);
    expect(artifactIsReviewable(ARTIFACT)).toBe(true);

    await expect(
      h.engine.submitCapstone(topic.id, 'done'),
    ).rejects.toMatchObject({ code: 'validation' });
    expect(h.prompts).toHaveLength(0);
  });
});

describe('F13 path: submission falls short, revise, resubmit', () => {
  it('keeps every prior round of feedback visible and feeds it into the next review', async () => {
    const { topic } = seedTopic(h.store, { withCapstone: true });
    let call = 0;
    h.respondWith(() => {
      call += 1;
      return call === 1
        ? evaluatorOutput({
            reply: 'The encoder works but you never measure whether it actually compresses anything.',
            outcome: 'fail',
            misunderstanding: 'No evidence the design choice paid off.',
          })
        : evaluatorOutput({ reply: 'The measurement closes the gap. Passed.', mode: 'verdict', outcome: 'pass' });
    });

    const first = await h.engine.submitCapstone(topic.id, ARTIFACT);
    expect(first.verdict.outcome).toBe('continue');
    expect(first.completion).toBeNull();
    expect(h.engine.topicIsDone(topic.id)).toBe(false);

    const second = await h.engine.submitCapstone(topic.id, REVISED);
    expect(second.verdict.outcome).toBe('assisted-pass');

    const rounds = h.engine.rounds(topic.id);
    expect(rounds).toHaveLength(2);
    expect(rounds[0].artifact).toBe(ARTIFACT);
    expect(rounds[0].feedback).toContain('never measure whether it actually compresses');
    expect(rounds[1].artifact).toBe(REVISED);
    expect(rounds[1].verdict?.outcome).toBe('assisted-pass');

    expect(h.prompts[1]).toContain('Round 1 feedback');
    expect(h.prompts[1]).toContain('never measure whether it actually compresses');
  });
});

describe('F13 path: a purpose too vague for an authentic build', () => {
  it('reviews the synthesis design problem the fallback produced, still naming the driving question', async () => {
    const vague = 'stuff';
    expect(purposeIsBuildable(vague)).toBe(false);

    const { topic } = seedTopic(h.store, { purpose: vague, withCapstone: true, capstoneSpec: 'placeholder' });
    const graph = h.store.modules.graph(topic.id);
    const capstone = graph.nodes.find((n) => n.kind === 'capstone') as ModuleNode;
    const fallback = synthesisSpec(topic, 'How small can a message get?', graph);
    h.store.modules.upsertGraph({
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === capstone.id && n.content !== null
          ? { ...n, content: { ...n.content, explanation: { kind: 'text' as const, markdown: fallback } } }
          : n,
      ),
    });

    const session = h.engine.open('capstone', { kind: 'capstone', topicId: topic.id });
    expect(session.turns[0].text).toContain('Your project is to answer the driving question in full');
    expect(session.turns[0].text).toContain('How small can a message get?');

    h.respondWith(() => evaluatorOutput({ reply: 'That design holds together.', mode: 'verdict', outcome: 'pass' }));
    const result = await h.engine.submitCapstone(
      topic.id,
      'A full design for a coder that uses every lesson, with the trade-offs written out.',
    );
    expect(result.verdict.outcome).toBe('pass');
  });
});

describe('F13 path: attempted past the advisory with prerequisites incomplete', () => {
  it('lets the learner in with a warning and still reviews the work', async () => {
    const { topic, nodes } = seedTopic(h.store, { withCapstone: true });
    const graph = h.store.modules.graph(topic.id);
    const capstone = nodes[nodes.length - 1];
    const entry = canEnter(graph, capstone.id, completedSet(graph));

    expect(entry.enterable).toBe(true);
    expect(entry.advisory?.unmetPrereqs.map((p) => p.id)).toEqual(nodes.filter((n) => n.kind !== 'capstone').map((n) => n.id));

    h.respondWith(() => evaluatorOutput({ reply: 'Impressive, given you skipped ahead.', mode: 'verdict', outcome: 'pass' }));
    const result = await h.engine.submitCapstone(topic.id, ARTIFACT);

    expect(result.completion?.moduleId).toBe(capstone.id);
    // the topic is still not done: the lessons themselves were never passed
    expect(h.engine.topicIsDone(topic.id)).toBe(false);
    expect(capstoneRounds(h.store.evals.get(sessionIdFor('capstone', { kind: 'capstone', topicId: topic.id }))!)).toHaveLength(1);
  });
});

describe('F13: the tutor proposes the project', () => {
  function unwriteCapstone(topicId: Parameters<typeof h.store.modules.graph>[0]): void {
    const graph = h.store.modules.graph(topicId);
    h.store.modules.upsertGraph({
      ...graph,
      nodes: graph.nodes.map((n) => (n.kind === 'capstone' ? { ...n, content: null } : n)),
    });
  }

  it('will not open a review while the project has no brief to build against', async () => {
    const { topic } = seedTopic(h.store, { withCapstone: true });
    unwriteCapstone(topic.id);

    expect(() => h.engine.open('capstone', { kind: 'capstone', topicId: topic.id })).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
    await expect(h.engine.submitCapstone(topic.id, ARTIFACT)).rejects.toMatchObject({ code: 'conflict' });
    expect(h.prompts).toHaveLength(0);
  });

  it('brings an untouched review up to date with a brief written after it was opened', () => {
    const { topic } = seedTopic(h.store, { withCapstone: true, capstoneSpec: 'The old brief.' });
    const target = { kind: 'capstone' as const, topicId: topic.id };
    expect(h.engine.open('capstone', target).turns[0].text).toContain('The old brief.');

    const graph = h.store.modules.graph(topic.id);
    h.store.modules.upsertGraph({
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.kind === 'capstone' && n.content !== null
          ? { ...n, content: { ...n.content, explanation: { kind: 'text' as const, markdown: 'The tutor’s brief.' } } }
          : n,
      ),
    });

    const peeked = h.engine.peek('capstone', target);
    expect(peeked?.turns).toHaveLength(1);
    expect(peeked?.turns[0].text).toContain('The tutor’s brief.');
    expect(peeked?.turns[0].text).not.toContain('The old brief.');
  });

  it('leaves a review alone once something has been handed in against the old brief', async () => {
    const { topic } = seedTopic(h.store, { withCapstone: true, capstoneSpec: 'The old brief.' });
    h.respondWith(() => evaluatorOutput({ reply: 'Measure it.', mode: 'question', outcome: 'continue' }));
    await h.engine.submitCapstone(topic.id, ARTIFACT);

    const graph = h.store.modules.graph(topic.id);
    h.store.modules.upsertGraph({
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.kind === 'capstone' && n.content !== null
          ? { ...n, content: { ...n.content, explanation: { kind: 'text' as const, markdown: 'A new brief.' } } }
          : n,
      ),
    });

    const peeked = h.engine.peek('capstone', { kind: 'capstone', topicId: topic.id });
    expect(peeked?.turns[0].text).toContain('The old brief.');
    expect(peeked?.turns.some((t) => t.role === 'learner')).toBe(true);
  });
});
