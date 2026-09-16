// FRACTAL: covers F4 | type unit
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootHarness, evaluatorOutput, seedTopic, type Harness } from '@/eval/harness.testing';

let h: Harness;

beforeEach(() => {
  h = bootHarness();
});

afterEach(async () => {
  await h.teardown();
});

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i < 0 ? null : (argv[i + 1] ?? null);
}

describe('F4 quality: a chat is one conversation, not a cold start per turn', () => {
  it('opens a named CLI conversation and resumes it for the next turn', async () => {
    const { nodes } = seedTopic(h.store);
    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[0].id });
    h.respondWith(() => evaluatorOutput({ reply: 'Say more about the constant-length case.' }));

    await h.engine.send(
      session.id,
      { text: 'Entropy is the expected surprise.', selfAssessment: null },
    );
    await h.engine.send(
      session.id,
      { text: 'If every symbol is equally likely the code lengths are all the same.', selfAssessment: null },
    );

    expect(h.spawns).toHaveLength(2);
    const opened = flag(h.spawns[0].argv, '--session-id');
    expect(opened).not.toBeNull();
    expect(flag(h.spawns[0].argv, '--resume')).toBeNull();
    expect(flag(h.spawns[1].argv, '--resume')).toBe(opened);
    expect(flag(h.spawns[1].argv, '--session-id')).toBeNull();

    // The point of resuming: the second turn carries the learner's new message and
    // nothing else. The lesson, the criteria and the transcript are already in the
    // conversation, and re-sending them is the warm-up cost this removes.
    expect(h.prompts[0]).toContain('Topic subject');
    expect(h.prompts[1]).not.toContain('Topic subject');
    expect(h.prompts[1]).not.toContain('Pass criterion');
    expect(h.prompts[1]).toContain('If every symbol is equally likely');
    expect(h.prompts[1].length).toBeLessThan(h.prompts[0].length / 2);
  });

  it('re-opens from scratch when the CLI has forgotten the conversation', async () => {
    const { nodes } = seedTopic(h.store);
    const session = h.engine.open('module', { kind: 'module', moduleId: nodes[1].id });
    // A resumed turn is the short one; refusing exactly those simulates a transcript the
    // CLI no longer has, which is the only way this app learns the conversation is gone.
    h.respondWith((prompt) =>
      prompt.includes('Topic subject') ? evaluatorOutput({ reply: 'Go on.' }) : 'fail',
    );

    await h.engine.send(
      session.id,
      { text: 'A prefix code is one where no codeword prefixes another.', selfAssessment: null },
    );
    const second = await h.engine.send(
      session.id,
      { text: 'So decoding never has to look ahead.', selfAssessment: null },
    );

    expect(second.verdict.outcome).toBe('continue');
    expect(h.spawns).toHaveLength(3);
    const first = flag(h.spawns[0].argv, '--session-id');
    expect(flag(h.spawns[1].argv, '--resume')).toBe(first);
    // The fallback is the session that would have run without any of this: full brief,
    // its own conversation id, and the learner never sees the failed attempt.
    const reopened = flag(h.spawns[2].argv, '--session-id');
    expect(reopened).not.toBeNull();
    expect(reopened).not.toBe(first);
    expect(h.prompts[2]).toContain('So decoding never has to look ahead');
    expect(h.prompts[2]).toContain('Pass criterion');
  });
});
