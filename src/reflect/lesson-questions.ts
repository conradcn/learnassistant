// FRACTAL: implements F3 | component C8
import type { LessonQuestion, ModuleId, TopicId } from '@/shapes';
import type { Store } from '@/store/open';
import { log } from '@/core/log';

/**
 * WHY a note and not a table: an answered question is the same kind of thing as a warm-up
 * attempt — the learner's own words about one lesson, written while reading it — and that
 * already has a home. Storing it as a marked reflection means it survives a reload, shows
 * up in the journal where the learner can see what they were stuck on, and costs no
 * migration. These two markers are the whole format; the writer and the reader are here
 * together so they cannot drift apart.
 */
export const LESSON_QUESTION_PREFIX = 'Asked while reading this lesson: ';
export const LESSON_ANSWER_SEPARATOR = '\n\nYour tutor answered: ';

export function lessonQuestionNote(question: string, answer: string): string {
  return `${LESSON_QUESTION_PREFIX}${question}${LESSON_ANSWER_SEPARATOR}${answer}`;
}

/** The exchanges hidden in a module's notes, oldest first. */
export function lessonQuestionsFromNotes(texts: readonly string[]): LessonQuestion[] {
  const out: LessonQuestion[] = [];
  for (const text of texts) {
    if (!text.startsWith(LESSON_QUESTION_PREFIX)) continue;
    const body = text.slice(LESSON_QUESTION_PREFIX.length);
    const split = body.indexOf(LESSON_ANSWER_SEPARATOR);
    // A note whose answer marker is gone was edited by hand in the journal; the question
    // is still the learner's, so it is shown rather than dropped.
    if (split === -1) {
      out.push({ question: body, answer: '' });
      continue;
    }
    out.push({
      question: body.slice(0, split),
      answer: body.slice(split + LESSON_ANSWER_SEPARATOR.length),
    });
  }
  return out;
}

export function lessonQuestionsFor(store: Store, topicId: TopicId, moduleId: ModuleId): LessonQuestion[] {
  try {
    return lessonQuestionsFromNotes(
      store.reflections
        .listByTopic(topicId)
        .filter((r) => r.moduleId === moduleId)
        .map((r) => r.text),
    );
  } catch (e) {
    log({
      level: 'warn',
      event: 'lesson-questions-read-failed',
      component: 'C8',
      moduleId,
      detail: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}
