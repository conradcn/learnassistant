// FRACTAL: implements F8 | component C7
import type { ISODateString, ModuleId, PracticeQuestion, TopicId } from '@/shapes';
import { mixPlanSchema, type MixPlan } from '@/review/shapes';

export { mixPlanSchema };
export type { MixPlan };

export type PracticeCandidate = {
  moduleId: ModuleId;
  topicId: TopicId;
  moduleTitle: string;
  question: string;
  due: boolean;
  dueAt: ISODateString | null;
};

export type Mixed = { plan: MixPlan; picks: PracticeCandidate[] };

function groupByTopic(candidates: PracticeCandidate[]): Map<TopicId, PracticeCandidate[]> {
  const groups = new Map<TopicId, PracticeCandidate[]>();
  for (const c of candidates) {
    const bucket = groups.get(c.topicId);
    if (bucket === undefined) groups.set(c.topicId, [c]);
    else bucket.push(c);
  }
  // WHY (F8): due material comes first inside each topic, so the session is
  // drawn preferentially from F7's queue and tops up from the rest.
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => {
      if (a.due !== b.due) return a.due ? -1 : 1;
      if (a.dueAt !== null && b.dueAt !== null && a.dueAt !== b.dueAt) return a.dueAt < b.dueAt ? -1 : 1;
      return a.moduleId < b.moduleId ? -1 : 1;
    });
  }
  return groups;
}

export function perTopicCap(total: number): number {
  return Math.ceil(total / 2);
}

// WHY (F8 AC): with two or more qualifying topics no topic may supply more than
// ceil(n/2) questions, so a session can never be drawn entirely from one topic.
export function mix(candidates: PracticeCandidate[], size: number): Mixed {
  const requested = Math.max(0, Math.floor(size));
  const groups = groupByTopic(candidates);
  const topics = [...groups.keys()].sort((a, b) => {
    const da = groups.get(a) ?? [];
    const db = groups.get(b) ?? [];
    const dueA = da.filter((c) => c.due).length;
    const dueB = db.filter((c) => c.due).length;
    if (dueA !== dueB) return dueB - dueA;
    if (da.length !== db.length) return db.length - da.length;
    return a < b ? -1 : 1;
  });
  const total = Math.min(requested, candidates.length);
  const cap = topics.length >= 2 ? perTopicCap(total) : total;

  const cursors = new Map<TopicId, number>(topics.map((t) => [t, 0]));
  const taken = new Map<TopicId, number>(topics.map((t) => [t, 0]));
  const picks: PracticeCandidate[] = [];
  let progressed = true;
  while (picks.length < total && progressed) {
    progressed = false;
    for (const topicId of topics) {
      if (picks.length >= total) break;
      const bucket = groups.get(topicId) ?? [];
      const cursor = cursors.get(topicId) ?? 0;
      if (cursor >= bucket.length) continue;
      if ((taken.get(topicId) ?? 0) >= cap) continue;
      picks.push(bucket[cursor]);
      cursors.set(topicId, cursor + 1);
      taken.set(topicId, (taken.get(topicId) ?? 0) + 1);
      progressed = true;
    }
  }

  const perTopic = topics
    .map((topicId) => ({ topicId, count: taken.get(topicId) ?? 0 }))
    .filter((row) => row.count > 0);
  const plan = mixPlanSchema.parse({
    perTopic,
    total: picks.length,
    fellBackToSingleTopic: topics.length <= 1,
  });
  return { plan, picks };
}

export function toQuestions(picks: PracticeCandidate[]): PracticeQuestion[] {
  return picks.map((c) => ({
    moduleId: c.moduleId,
    topicId: c.topicId,
    text: c.question,
    answered: false,
    correct: null,
  }));
}
