// FRACTAL: covers F3 | type integration
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, closeStore, type Store } from '@/store/open';
import { exampleModuleId, exampleTopicId, type ModuleId } from '@/shapes';
import {
  lessonQuestionNote,
  lessonQuestionsFor,
  lessonQuestionsFromNotes,
} from '@/reflect/lesson-questions';
import { warmUpFromNotes, warmUpNote } from '@/reflect/warm-up';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'la-ask-'));
  store = openStore(dir);
});

afterEach(() => {
  closeStore(dir);
  rmSync(dir, { recursive: true, force: true });
});

describe('questions asked while reading a lesson', () => {
  it('reads back out of the note they were written into, oldest first', () => {
    const notes = [lessonQuestionNote('Why bits?', 'One yes/no question.'), lessonQuestionNote('And logs?', 'They add.')];
    expect(lessonQuestionsFromNotes(notes)).toEqual([
      { question: 'Why bits?', answer: 'One yes/no question.' },
      { question: 'And logs?', answer: 'They add.' },
    ]);
  });

  it('keeps a question whose answer was edited away in the journal', () => {
    expect(lessonQuestionsFromNotes(['Asked while reading this lesson: Why bits?'])).toEqual([
      { question: 'Why bits?', answer: '' },
    ]);
  });

  it('does not collide with the warm-up, which shares the same notes', () => {
    const notes = [warmUpNote('three questions'), lessonQuestionNote('Why bits?', 'One question.')];
    expect(lessonQuestionsFromNotes(notes)).toEqual([{ question: 'Why bits?', answer: 'One question.' }]);
    expect(warmUpFromNotes(notes)).toEqual({ stage: 'attempted', text: 'three questions' });
  });

  it('survives the round trip through the store, and stays scoped to its own lesson', () => {
    const other = 'm_0d9fQ2xK4mZa71bC' as ModuleId;
    store.reflections.create({
      topicId: exampleTopicId,
      moduleId: exampleModuleId,
      text: lessonQuestionNote('Why bits?', 'One question.'),
    });
    store.reflections.create({
      topicId: exampleTopicId,
      moduleId: other,
      text: lessonQuestionNote('Someone else lesson', 'Another answer.'),
    });

    expect(lessonQuestionsFor(store, exampleTopicId, exampleModuleId)).toEqual([
      { question: 'Why bits?', answer: 'One question.' },
    ]);
    expect(lessonQuestionsFor(store, exampleTopicId, other)).toEqual([
      { question: 'Someone else lesson', answer: 'Another answer.' },
    ]);
  });
});
