// FRACTAL: implements F8, F9 | component C10
import type { ApiResponse, DashboardTopic, PracticeSession } from '@/shapes';
import type { LoadState } from '@/ui/shapes';
import { REMEMBERED_LABEL } from '@/ui/review-copy';

export const PRACTICE_SIZE = 8;
export const PRACTICE_INTRO =
  'A short mixed set, pulled from lessons you have already finished across your subjects. Stop whenever you like — everything you answer is kept.';
export const PRACTICE_EMPTY_MESSAGE =
  'Nothing to practise yet — finish a lesson and it will start showing up here.';
// WHY: practice and the review queue link straight to each other and ask the same
// question about the same lessons, so they answer it in the same words. The negative
// label was already shared; this is the positive half of the same pair.
export const PRACTICE_GOT_IT = REMEMBERED_LABEL;
export const PRACTICE_MISSED = 'I had forgotten this';
export const PRACTICE_SKIP = 'Skip for now';
export const PRACTICE_STOP = 'Stop for now';

export const SYNTHESIS_INTRO =
  'Once you have finished lessons in two different subjects, you can be asked to explain how they connect.';
export const SYNTHESIS_UNAVAILABLE =
  'Linking two subjects needs finished lessons in at least two of them. Finish some lessons and this opens up on its own.';
export const SYNTHESIS_START = 'Start this conversation';

/**
 * WHY (H3): a practice run with nothing finished yet is a normal place to be, and the
 * only failure the app reports as empty is that exact one. Everything else stays an error.
 */
export function practiceState(response: ApiResponse<PracticeSession>): LoadState<PracticeSession> {
  if (response.ok) {
    return response.data.questions.length === 0 ? { status: 'empty' } : { status: 'ready', data: response.data };
  }
  if (response.error.code === 'conflict') return { status: 'empty' };
  return { status: 'error', error: response.error };
}

export function answeredLine(session: PracticeSession): string {
  const left = session.questions.length - session.answeredCount;
  if (left <= 0) return `All ${session.questions.length} done. Nice work.`;
  return `${session.answeredCount} answered, ${left} to go`;
}

/**
 * What is said out loud after a rating. WHY it repeats the button's own label back: the
 * rating buttons outlive the question swap, so focus never moves and nothing is re-read
 * — without this the learner cannot tell "registered, next question" from "the button
 * did nothing" (WCAG SC 4.1.3). The count is what makes each announcement differ from
 * the last, which is what makes a screen reader speak it again at all; "Next question"
 * is what confirms the stem behind the unchanged buttons was replaced.
 */
export function ratingAnnouncement(session: PracticeSession, correct: boolean): string {
  const label = correct ? PRACTICE_GOT_IT : PRACTICE_MISSED;
  return `${label}. ${answeredLine(session)}. Next question.`;
}

export function stoppedLine(session: PracticeSession): string {
  return session.answeredCount === 1
    ? 'You stopped after 1 question. It is kept.'
    : `You stopped after ${session.answeredCount} questions. They are all kept.`;
}

export function synthesisCandidates(topics: readonly DashboardTopic[]): DashboardTopic[] {
  return topics.filter((topic) => topic.completedCount > 0);
}

export function synthesisReady(topics: readonly DashboardTopic[]): boolean {
  return synthesisCandidates(topics).length >= 2;
}

export function synthesisQuestionLine(a: string, b: string): string {
  return `How does what you learned in ${a} connect to ${b}?`;
}

/**
 * The heading the summary card carries, which is also what focus lands on when a run
 * ends. WHY it names the ending rather than just saying "Summary": the same node is
 * read out on focus, and "That run is over" answers the question the learner has.
 */
export function practiceSummaryHeading(stopped: boolean): string {
  return stopped ? 'That run is over' : 'That run is finished';
}
