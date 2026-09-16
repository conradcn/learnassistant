// FRACTAL: implements F9 | component C6
import { createHash } from 'node:crypto';
import { moduleIdSchema, type EvalScript, type EvalSession, type ModuleId, type Topic, type TopicId } from '@/shapes';
import { TARGET_TAG_PREFIX } from '@/eval/angles';
import { evalTargetSchema, type EvalTarget } from '@/eval/shapes';

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// WHY: an EvalSession row carries exactly one module id and no target column
// (C1's schema), so a synthesis session gets a deterministic surrogate derived
// from the ordered topic pair. The same pair always resolves to the same row,
// which is what makes an abandoned synthesis chat resumable.
export function synthesisModuleId(topicA: TopicId, topicB: TopicId): ModuleId {
  const digest = createHash('sha256').update(`${topicA}|${topicB}`).digest();
  let out = '';
  for (let i = 0; i < 16; i += 1) out += ID_ALPHABET[digest[i] % ID_ALPHABET.length];
  return moduleIdSchema.parse(`m_${out}`);
}

export function encodeTargetTag(target: EvalTarget): string {
  if (target.kind === 'synthesis') return `${TARGET_TAG_PREFIX}synthesis:${target.topicA}:${target.topicB}`;
  if (target.kind === 'capstone') return `${TARGET_TAG_PREFIX}capstone:${target.topicId}`;
  return `${TARGET_TAG_PREFIX}${target.kind}:${target.moduleId}`;
}

// WHY: the tag lives on the opening evaluator turn, which is persisted before
// anything else happens, so resume() reconstructs the target from durable state
// rather than from a process-local map that a restart would lose.
export function decodeTargetTag(tag: string): EvalTarget | null {
  if (!tag.startsWith(TARGET_TAG_PREFIX)) return null;
  const parts = tag.slice(TARGET_TAG_PREFIX.length).split(':');
  if (parts[0] === 'synthesis' && parts.length === 3) {
    const parsed = evalTargetSchema.safeParse({ kind: 'synthesis', topicA: parts[1], topicB: parts[2] });
    return parsed.success ? parsed.data : null;
  }
  if (parts[0] === 'capstone' && parts.length === 2) {
    const parsed = evalTargetSchema.safeParse({ kind: 'capstone', topicId: parts[1] });
    return parsed.success ? parsed.data : null;
  }
  if ((parts[0] === 'module' || parts[0] === 'test-out' || parts[0] === 'review') && parts.length === 2) {
    const parsed = evalTargetSchema.safeParse({ kind: parts[0], moduleId: parts[1] });
    return parsed.success ? parsed.data : null;
  }
  return null;
}

export function targetOfSession(session: EvalSession): EvalTarget | null {
  for (const turn of session.turns) {
    if (turn.angle === null) continue;
    const decoded = decodeTargetTag(turn.angle);
    if (decoded !== null) return decoded;
  }
  return null;
}

// WHY (F9): the feature is inactive with fewer than two topics that have any
// completed work — it is shown as unavailable rather than offered and then
// failing when it is opened.
export function synthesisCandidates(topics: Topic[], completedCounts: Map<TopicId, number>): TopicId[] {
  return topics
    .filter((t) => (completedCounts.get(t.id) ?? 0) > 0)
    .map((t) => t.id);
}

export function synthesisAvailable(candidates: TopicId[]): boolean {
  return candidates.length >= 2;
}

// WHY (F9 AC): both topics are named explicitly in the question text by US, not
// left to the model, so the naming cannot be lost to a bad generation.
export function synthesisOpeningQuestion(topicA: Topic, topicB: Topic): string {
  return [
    `You have worked through both ${topicA.subject} and ${topicB.subject}.`,
    '',
    `Take one idea from ${topicA.subject} and one from ${topicB.subject} and show me how they are the same idea wearing different clothes — or explain exactly why they are not.`,
    'Work it all the way through; a name-drop is not an answer.',
  ].join('\n');
}

export function namesBothTopics(text: string, topicA: Topic, topicB: Topic): boolean {
  const lower = text.toLowerCase();
  return lower.includes(topicA.subject.toLowerCase()) && lower.includes(topicB.subject.toLowerCase());
}

export function synthesisScript(topicA: Topic, topicB: Topic): EvalScript {
  return {
    objectives: [`Connect ${topicA.subject} and ${topicB.subject} through a worked argument`],
    seedQuestions: [synthesisOpeningQuestion(topicA, topicB)],
    angles: ['shared structure', 'where the analogy breaks', 'a problem that needs both'],
    misconceptions: [],
    passCriteria: [
      `Names a specific idea from ${topicA.subject} and a specific idea from ${topicB.subject}`,
      'Works the connection through instead of asserting it',
    ],
  };
}

// WHY (F9 AC): a synthesis verdict is additive. No branch of the turn pipeline
// may reach completeModule for one of these, so the guard is a single exported
// predicate every caller asks.
export function affectsCompletion(target: EvalTarget): boolean {
  return target.kind !== 'synthesis';
}
