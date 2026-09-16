// FRACTAL: implements F4 | component C6
import type { EvalVerdict, Job, ModuleId, Topic } from '@/shapes';
import { AppError } from '@/core/errors';
import { log } from '@/core/log';

export const REMEDIAL_FAILURE_THRESHOLD = 3;

export type RemedialRequester = {
  requestRemedial(moduleId: ModuleId, concept: string): Job;
};

export type RemedialOutcome =
  | { queued: true; jobId: string; message: string }
  | { queued: false; reason: 'declined' | 'failed'; message: string };

export function shouldRequestRemedial(consecutiveFailures: number, verdict: EvalVerdict): boolean {
  return consecutiveFailures >= REMEDIAL_FAILURE_THRESHOLD || verdict.remedialNeeded;
}

export function conceptFor(verdict: EvalVerdict, fallbackTitle: string): string {
  const named = verdict.misunderstanding?.trim() ?? '';
  return named.length > 0 ? named : fallbackTitle;
}

export const DECLINED_MESSAGE =
  'This subject needs attention before a new practice lesson can be written for it. We can keep going here with hints instead.';

// WHY (mastery learning): three consecutive failures must bring NEW instructional
// input, never another re-ask of the same idea. The request is refused outright
// when the subject is already in trouble, and the refusal is spoken plainly to
// the learner instead of silently re-entering the loop.
export function requestRemedial(
  orchestrator: RemedialRequester,
  topic: Topic,
  moduleId: ModuleId,
  concept: string,
): RemedialOutcome {
  if (topic.status === 'needs-attention') {
    log({ level: 'warn', event: 'eval-remedial-declined', component: 'C6', topicId: topic.id, reason: 'needs-attention' });
    return { queued: false, reason: 'declined', message: DECLINED_MESSAGE };
  }
  try {
    const job = orchestrator.requestRemedial(moduleId, concept);
    log({ level: 'info', event: 'eval-remedial-queued', component: 'C6', topicId: topic.id, moduleId, jobId: job.id });
    return {
      queued: true,
      jobId: job.id,
      message: 'We are putting together a short practice lesson on this before asking again.',
    };
  } catch (e) {
    if (e instanceof AppError) {
      log({ level: 'warn', event: 'eval-remedial-refused', component: 'C6', topicId: topic.id, code: e.code, correlationId: e.correlationId });
      return { queued: false, reason: 'failed', message: `${e.message} We can keep going here with hints instead.` };
    }
    throw e;
  }
}
