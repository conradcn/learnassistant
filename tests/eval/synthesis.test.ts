// FRACTAL: covers F9 | type unit
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModuleId, Topic, TopicId } from '@/shapes';
import { isPassedState } from '@/graph/availability';
import {
  affectsCompletion,
  decodeTargetTag,
  namesBothTopics,
  synthesisAvailable,
  synthesisCandidates,
  synthesisModuleId,
  synthesisOpeningQuestion,
  synthesisScript,
} from '@/eval/synthesis';
import { bootHarness, evaluatorOutput, seedTopic, type Harness } from '@/eval/harness.testing';

let h: Harness;

beforeEach(() => {
  h = bootHarness();
});

afterEach(async () => {
  await h.teardown();
});

function completedCounts(topics: Topic[]): Map<TopicId, number> {
  const counts = new Map<TopicId, number>();
  for (const t of topics) {
    counts.set(t.id, h.store.modules.graph(t.id).nodes.filter((n) => isPassedState(n.state)).length);
  }
  return counts;
}

function seedPair(): { a: Topic; b: Topic; aFirst: ModuleId; bFirst: ModuleId } {
  const first = seedTopic(h.store, { subject: 'Information theory' });
  const second = seedTopic(h.store, { subject: 'Thermodynamics', titles: ['Heat and disorder', 'Free energy'] });
  h.store.modules.setState(first.nodes[0].id, 'completed');
  h.store.modules.setState(second.nodes[0].id, 'completed');
  return { a: first.topic, b: second.topic, aFirst: first.nodes[0].id, bFirst: second.nodes[0].id };
}

describe('F9: when a synthesis prompt is offered at all', () => {
  it('is inactive with fewer than two topics that have completed work', () => {
    const only = seedTopic(h.store, { subject: 'Graph theory' });
    expect(synthesisAvailable(synthesisCandidates([only.topic], completedCounts([only.topic])))).toBe(false);

    h.store.modules.setState(only.nodes[0].id, 'completed');
    expect(synthesisAvailable(synthesisCandidates([only.topic], completedCounts([only.topic])))).toBe(false);

    const { a, b } = seedPair();
    expect(synthesisAvailable(synthesisCandidates([a, b], completedCounts([a, b])))).toBe(true);
  });

  it('names both topics explicitly in the question and in the pass criteria', () => {
    const { a, b } = seedPair();
    const question = synthesisOpeningQuestion(a, b);
    expect(namesBothTopics(question, a, b)).toBe(true);
    expect(synthesisScript(a, b).passCriteria.some((c) => namesBothTopics(c, a, b))).toBe(true);
  });

  it('derives a stable surrogate id and a decodable target tag for the pair', () => {
    const { a, b } = seedPair();
    expect(synthesisModuleId(a.id, b.id)).toBe(synthesisModuleId(a.id, b.id));
    expect(synthesisModuleId(a.id, b.id)).not.toBe(synthesisModuleId(b.id, a.id));
    expect(decodeTargetTag(`target:synthesis:${a.id}:${b.id}`)).toEqual({ kind: 'synthesis', topicA: a.id, topicB: b.id });
    expect(decodeTargetTag('target:synthesis:not-an-id:also-not')).toBeNull();
    expect(affectsCompletion({ kind: 'synthesis', topicA: a.id, topicB: b.id })).toBe(false);
  });
});

describe('F9: the synthesis exchange itself', () => {
  it('passes without touching either topic completion state', async () => {
    const { a, b, aFirst, bFirst } = seedPair();
    const session = h.engine.open('synthesis', { kind: 'synthesis', topicA: a.id, topicB: b.id });
    expect(namesBothTopics(session.turns[0].text, a, b)).toBe(true);

    h.respondWith(() =>
      evaluatorOutput({
        reply: 'That is the connection, worked all the way through.',
        mode: 'verdict',
        outcome: 'pass',
        rationale: `Names a specific idea from ${a.subject} and a specific idea from ${b.subject}.`,
      }),
    );

    const before = [h.store.modules.graph(a.id), h.store.modules.graph(b.id)].map((g) =>
      g.nodes.map((n) => n.state).join(','),
    );
    const result = await h.engine.send(
      session.id,
      { text: 'Shannon entropy and Gibbs entropy are the same expectation over a distribution.', selfAssessment: null },
    );

    expect(result.verdict.outcome).toBe('pass');
    expect(result.completion).toBeNull();
    const after = [h.store.modules.graph(a.id), h.store.modules.graph(b.id)].map((g) =>
      g.nodes.map((n) => n.state).join(','),
    );
    expect(after).toEqual(before);
    expect(h.store.modules.graph(a.id).nodes.find((n) => n.id === aFirst)?.state).toBe('completed');
    expect(h.store.modules.graph(b.id).nodes.find((n) => n.id === bFirst)?.state).toBe('completed');
  });

  it('explains the shortfall and re-asks from a different angle after a failure', async () => {
    const { a, b } = seedPair();
    const session = h.engine.open('synthesis', { kind: 'synthesis', topicA: a.id, topicB: b.id });
    h.respondWith(() =>
      evaluatorOutput({
        reply: 'Where exactly does the analogy stop holding?',
        outcome: 'fail',
        misunderstanding: 'That named the two ideas without connecting them.',
      }),
    );

    const result = await h.engine.send(
      session.id,
      { text: 'They both mention entropy.', selfAssessment: null },
    );

    expect(result.verdict.outcome).toBe('continue');
    expect(result.evaluatorTurn.mode).toBe('hint');
    expect(result.evaluatorTurn.text).toContain('That named the two ideas without connecting them.');
    expect(result.evaluatorTurn.text).not.toBe(session.turns[0].text);
    // A hint scaffolds the question already on the table, so it carries that question's
    // angle rather than spending a new one — and the opening question has none yet.
    expect(result.evaluatorTurn.angle).toBeNull();
    expect(result.completion).toBeNull();
  });
});
