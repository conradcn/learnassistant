// FRACTAL: covers F4 | type unit
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evalTurnResultSchema } from '@/eval/shapes';
import { bootHarness, evaluatorOutput, seedTopic, type Harness } from '@/eval/harness.testing';

let h: Harness;

beforeEach(() => {
  h = bootHarness();
});

afterEach(async () => {
  await h.teardown();
});

describe('F4 happy path: one unassisted evaluation turn', () => {
  it('passes cleanly, completes the lesson and opens the next one', async () => {
    const { topic, nodes } = seedTopic(h.store);
    h.respondWith(() => evaluatorOutput({ reply: 'That is exactly it.', mode: 'verdict', outcome: 'pass' }));
    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });

    const result = await h.engine.send(
      session.id,
      { text: 'Entropy is the expected code length over the whole distribution.', selfAssessment: null },
    );

    expect(() => evalTurnResultSchema.parse(result)).not.toThrow();
    expect(result.verdict.outcome).toBe('pass');
    expect(result.verdict.assistLevel).toBe(0);
    expect(result.completion?.moduleId).toBe(nodes[0].id);
    expect(result.completion?.unlocked).toEqual([nodes[1].id]);
    expect(result.session.status).toBe('passed');

    const graph = h.store.modules.graph(topic.id);
    expect(graph.nodes[0].state).toBe('completed');
    expect(graph.nodes[1].state).toBe('available');
  });

  it('persists the learner turn before the evaluator is ever consulted', async () => {
    const { nodes } = seedTopic(h.store);
    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });
    let turnsWhenModelWasCalled = 0;
    h.respondWith(() => {
      turnsWhenModelWasCalled = h.store.evals.get(session.id)?.turns.length ?? 0;
      return evaluatorOutput({ reply: 'Keep going — what happens with a biased coin?', angle: 'compression' });
    });

    await h.engine.send(
      session.id,
      { text: 'A fair coin is one bit.', selfAssessment: { confidence: 2, critique: 'Not sure about bias.' } },
    );

    expect(turnsWhenModelWasCalled).toBe(2);
    const stored = h.store.evals.get(session.id);
    expect(stored?.turns).toHaveLength(3);
    expect(stored?.turns[1].role).toBe('learner');
    expect(stored?.turns[1].selfAssessment).toEqual({ confidence: 2, critique: 'Not sure about bias.' });
    expect(stored?.turns[2].angle).toBe('compression');
  });

  it('keeps the learner message and records no verdict when the evaluator fails', async () => {
    const { topic, nodes } = seedTopic(h.store);
    h.respondWith(() => 'fail');
    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });

    await expect(
      h.engine.send(
        session.id,
        { text: 'The answer I do not want to retype.', selfAssessment: null },
      ),
    ).rejects.toMatchObject({ code: 'cli-failed' });

    const stored = h.store.evals.get(session.id);
    expect(stored?.turns).toHaveLength(2);
    expect(stored?.turns[1].text).toBe('The answer I do not want to retype.');
    expect(stored?.turns.some((t) => t.role === 'evaluator' && t.mode === 'verdict')).toBe(false);
    expect(h.store.modules.graph(topic.id).nodes[0].state).toBe('available');
  });

  it('rejects an over-long message at the boundary instead of sending it', async () => {
    const { nodes } = seedTopic(h.store);
    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });

    await expect(
      h.engine.send(
        session.id,
        { text: 'x'.repeat(9000), selfAssessment: null },
      ),
    ).rejects.toMatchObject({ code: 'validation' });
    expect(h.prompts).toHaveLength(0);
  });
});
