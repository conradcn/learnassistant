// FRACTAL: covers F4 | type integration
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionIdSchema } from '@/shapes';
import { bootHarness, evaluatorOutput, seedTopic, type Harness } from '@/eval/harness.testing';

let h: Harness;

beforeEach(() => {
  h = bootHarness();
});

afterEach(async () => {
  await h.teardown();
});

describe('F4 path: the learner abandons mid-chat and comes back', () => {
  it('reopens the same conversation with every turn intact, across a restart', async () => {
    const { nodes } = seedTopic(h.store);
    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });
    h.respondWith(() => evaluatorOutput({ reply: 'Interesting — where does the distribution come in?' }));

    await h.engine.send(
      session.id,
      { text: 'Half-finished thought I walked away from.', selfAssessment: null },
    );

    const reopened = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });
    expect(reopened.id).toBe(session.id);
    expect(reopened.turns).toHaveLength(3);
    expect(reopened.turns[1].text).toBe('Half-finished thought I walked away from.');
    expect(reopened.status).toBe('open');

    const afterRestart = h.reopenStore();
    const persisted = afterRestart.evals.get(session.id);
    expect(persisted?.turns).toHaveLength(3);
    expect(persisted?.turns[2].text).toBe('Interesting — where does the distribution come in?');
  });

  it('reads back a stored conversation without opening one, and says so when there is none', async () => {
    const { nodes } = seedTopic(h.store);
    expect(h.engine.peek('module', { kind: 'module', moduleId: nodes[0].id })).toBeNull();

    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });
    h.respondWith(() => evaluatorOutput({ reply: 'Say more about the alphabet.' }));
    await h.engine.send(
      session.id,
      { text: 'A partial answer.', selfAssessment: null },
    );

    const peeked = h.engine.peek('module', { kind: 'module', moduleId: nodes[0].id });
    expect(peeked?.id).toBe(session.id);
    expect(peeked?.turns).toHaveLength(3);
    // The peek is a read: it must not have created a second conversation for the sibling.
    expect(h.engine.peek('module', { kind: 'module', moduleId: nodes[1].id })).toBeNull();
  });

  it('starts over only when asked, back to the opening question and nothing else', async () => {
    const { nodes } = seedTopic(h.store);
    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });
    const opening = session.turns[0].text;
    h.respondWith(() => evaluatorOutput({ reply: 'Keep going.' }));
    await h.engine.send(
      session.id,
      { text: 'Something I would rather not have said.', selfAssessment: null },
    );
    expect(h.engine.resume(session.id).turns).toHaveLength(3);

    const fresh = h.engine.restart(session.id);
    expect(fresh.id).toBe(session.id);
    expect(fresh.turns).toHaveLength(1);
    expect(fresh.turns[0].text).toBe(opening);
    expect(fresh.status).toBe('open');
    expect(fresh.consecutiveFailures).toBe(0);

    // And it is still a live conversation afterwards.
    h.respondWith(() => evaluatorOutput({ reply: 'Better — what about the tail?' }));
    await h.engine.send(
      session.id,
      { text: 'A second, better attempt.', selfAssessment: null },
    );
    expect(h.engine.resume(session.id).turns).toHaveLength(3);

    // The discarded turns are gone from disk, not just from the reply.
    const afterRestart = h.reopenStore();
    const persisted = afterRestart.evals.get(session.id);
    expect(persisted?.turns).toHaveLength(3);
    expect(persisted?.turns.map((t) => t.text)).not.toContain('Something I would rather not have said.');
  });

  it('records an explicit walk-away and refuses further turns on it', async () => {
    const { nodes } = seedTopic(h.store);
    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });
    h.respondWith(() => evaluatorOutput({ reply: 'Go on.' }));
    await h.engine.send(
      session.id,
      { text: 'A first pass at the answer.', selfAssessment: null },
    );

    h.engine.abandon(session.id);
    const resumed = h.engine.resume(session.id);
    expect(resumed.status).toBe('abandoned');
    expect(resumed.turns[1].text).toBe('A first pass at the answer.');

    await expect(
      h.engine.send(
        session.id,
        { text: 'One more go.', selfAssessment: null },
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('says so plainly when the conversation cannot be found', () => {
    expect(() => h.engine.resume(sessionIdSchema.parse('s_0000000000000000'))).toThrow(
      /could not find that conversation/i,
    );
  });
});
