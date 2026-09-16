// FRACTAL: covers F3, F4 | type integration
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canTestOut } from '@/graph/entry';
import { bootHarness, evaluatorOutput, seedTopic, type Harness } from '@/eval/harness.testing';

let h: Harness;

beforeEach(() => {
  h = bootHarness();
});

afterEach(async () => {
  await h.teardown();
});

describe('F3/F4 path: testing out of a lesson', () => {
  it('marks the lesson complete when the learner passes cold', async () => {
    const { topic, nodes } = seedTopic(h.store);
    expect(canTestOut(h.store.modules.graph(topic.id), nodes[0].id).allowed).toBe(true);

    h.respondWith(() => evaluatorOutput({ reply: 'Nothing left to teach you here.', mode: 'verdict', outcome: 'pass' }));
    const session = h.engine.open('test-out', { kind: 'test-out', moduleId: nodes[0].id });
    expect(session.kind).toBe('test-out');

    const result = await h.engine.send(
      session.id,
      { text: 'Entropy is the expectation of the surprise over the whole distribution.', selfAssessment: null },
    );

    expect(result.verdict.outcome).toBe('pass');
    expect(result.completion?.moduleId).toBe(nodes[0].id);
    expect(h.store.modules.graph(topic.id).nodes[0].state).toBe('completed');
    expect(h.store.modules.graph(topic.id).nodes[1].state).toBe('available');
  });

  it('routes a failed test-out into the lesson rather than into the remedial loop', async () => {
    const { topic, nodes } = seedTopic(h.store);
    const session = h.engine.open('test-out', { kind: 'test-out', moduleId: nodes[0].id });
    let call = 0;
    h.respondWith(() => {
      call += 1;
      return evaluatorOutput({
        reply: `Attempt ${call}: not there yet — try describing a source with ${call} unequal outcomes.`,
        outcome: 'fail',
        misunderstanding: 'Entropy is being read as a property of a single symbol.',
      });
    });

    for (let i = 0; i < 6; i += 1) {
      const result = await h.engine.send(
        session.id,
        { text: `Cold attempt number ${i}.`, selfAssessment: null },
      );
      expect(result.remedialQueued).toBe(false);
      expect(result.completion).toBeNull();
    }

    const graph = h.store.modules.graph(topic.id);
    expect(graph.nodes.some((n) => n.kind === 'remedial')).toBe(false);
    // the lesson is still there, unfinished and enterable — that is the route back in
    expect(graph.nodes[0].state).toBe('available');
    expect(h.store.jobs.claimNext()).toBeNull();
  });
});

describe('F4 path: two gates open on one lesson', () => {
  it('closes the conversation the learner never spoke in and keeps the one they did', async () => {
    const { nodes } = seedTopic(h.store);
    const lesson = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });
    const testOut = h.engine.open('test-out', { kind: 'test-out', moduleId: nodes[0].id });
    expect(lesson.id).not.toBe(testOut.id);

    h.respondWith(() => evaluatorOutput({ reply: 'Say more about the long-run average.' }));
    await h.engine.send(
      testOut.id,
      { text: 'Entropy is the expected surprise.', selfAssessment: null },
    );

    expect(h.engine.resume(lesson.id).status).toBe('abandoned');
    expect(h.engine.resume(testOut.id).status).toBe('open');
  });

  it('leaves a sibling alone once the learner has answered in it, and reopens a closed one', async () => {
    const { nodes } = seedTopic(h.store);
    const lesson = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });
    const testOut = h.engine.open('test-out', { kind: 'test-out', moduleId: nodes[0].id });

    h.respondWith(() => evaluatorOutput({ reply: 'Keep going — what happens with unequal outcomes?' }));
    await h.engine.send(
      lesson.id,
      { text: 'It is bits per symbol.', selfAssessment: null },
    );
    expect(h.engine.resume(testOut.id).status).toBe('abandoned');

    const reopened = h.engine.open('test-out', { kind: 'test-out', moduleId: nodes[0].id });
    expect(reopened.id).toBe(testOut.id);
    expect(reopened.status).toBe('open');
    expect(reopened.turns).toHaveLength(1);

    await h.engine.send(
      reopened.id,
      { text: 'It is the expectation of the surprise.', selfAssessment: null },
    );

    // the module conversation has the learner in it, so nothing closes it
    expect(h.engine.resume(lesson.id).status).toBe('open');
    expect(h.engine.resume(reopened.id).status).toBe('open');
  });
});
