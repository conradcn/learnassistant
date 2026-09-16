// FRACTAL: covers F3 | type integration
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootHarness, seedTopic, type Harness } from '@/eval/harness.testing';
import { askAboutLesson, ASK_EMPTY_MESSAGE } from '@/eval/ask';
import { lessonQuestionsFor } from '@/reflect/lesson-questions';
import { AppError } from '@/core/errors';
import type { ModuleId } from '@/shapes';

let h: Harness;

beforeEach(() => {
  h = bootHarness();
  h.respondWith(() => ({ answer: 'Because a bit **is** one yes/no question.' }));
});

afterEach(async () => {
  await h.teardown();
});

function deps() {
  return { store: h.store, runner: h.runner, dataRoot: h.dataRoot };
}

describe('asking a question about the lesson you are reading', () => {
  it('answers, and hands the answer back with the question that earned it', async () => {
    const { nodes } = seedTopic(h.store);
    const answered = await askAboutLesson(deps(), nodes[0].id, '  Why bits and not questions?  ');

    expect(answered.question).toBe('Why bits and not questions?');
    expect(answered.answer).toContain('yes/no question');
  });

  it('bounds the answer to what this lesson taught, and never asks the learner to prove anything', async () => {
    const { nodes } = seedTopic(h.store);
    await askAboutLesson(deps(), nodes[0].id, 'Why bits?');

    const prompt = h.prompts[h.prompts.length - 1];
    expect(prompt.startsWith('KIND: ask')).toBe(true);
    expect(prompt).toContain('The lesson the learner studied, in reading order');
    expect(prompt).toContain('Learner asks: Why bits?');
    expect(prompt).toContain('Do not quiz them');
    // The graded conversation's contract must not leak into a question the learner asked.
    expect(prompt).not.toContain('"verdict"');
  });

  it('is remembered, so the next visit shows what was already asked', async () => {
    const { topic, nodes } = seedTopic(h.store);
    await askAboutLesson(deps(), nodes[0].id, 'Why bits?');

    expect(lessonQuestionsFor(h.store, topic.id, nodes[0].id)).toEqual([
      { question: 'Why bits?', answer: 'Because a bit **is** one yes/no question.' },
    ]);
  });

  it('carries the earlier exchange into the next one, so a follow-up is not asked cold', async () => {
    const { nodes } = seedTopic(h.store);
    await askAboutLesson(deps(), nodes[0].id, 'Why bits?');
    await askAboutLesson(deps(), nodes[0].id, 'And why average it?');

    const prompt = h.prompts[h.prompts.length - 1];
    expect(prompt).toContain('Learner asked: Why bits?');
    expect(prompt).toContain('Learner asks: And why average it?');
  });

  it('changes nothing about progress — asking is not answering', async () => {
    const { topic, nodes } = seedTopic(h.store);
    await askAboutLesson(deps(), nodes[0].id, 'Why bits?');

    const after = h.store.modules.graph(topic.id).nodes;
    expect(after.map((n) => n.state)).toEqual(['available', 'not-yet-recommended']);
  });

  it('refuses an empty question and an unknown lesson without calling the model', async () => {
    const { nodes } = seedTopic(h.store);
    const before = h.prompts.length;

    await expect(askAboutLesson(deps(), nodes[0].id, '   ')).rejects.toThrow(AppError);
    await expect(askAboutLesson(deps(), nodes[0].id, '   ')).rejects.toMatchObject({
      message: ASK_EMPTY_MESSAGE,
    });
    await expect(
      askAboutLesson(deps(), 'm_0d9fQ2xK4mZa71bC' as ModuleId, 'Why bits?'),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(h.prompts.length).toBe(before);
  });

  it('fails loudly rather than inventing an answer when the session returns nothing usable', async () => {
    const { topic, nodes } = seedTopic(h.store);
    h.respondWith(() => ({ reply: 'wrong shape entirely' }));

    await expect(askAboutLesson(deps(), nodes[0].id, 'Why bits?')).rejects.toThrow(AppError);
    expect(lessonQuestionsFor(h.store, topic.id, nodes[0].id)).toEqual([]);
  });
});
