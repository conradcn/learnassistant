// FRACTAL: implements F4, F13 | component C6
import type { AssistLevel, EvalTurn, EvalVerdict } from '@/shapes';

export const MAX_ASSIST_LEVEL: AssistLevel = 3;
export const ASSISTED_PASS_THRESHOLD = 2;
// WHY (F13): a capstone review has no hint ladder — a resubmission only happens
// because a prior round's feedback told the learner what was missing, so any
// prior assistance at all makes the eventual pass an assisted one.
export const CAPSTONE_ASSISTED_PASS_THRESHOLD = 1;

export function escalate(level: AssistLevel): AssistLevel {
  return (level >= MAX_ASSIST_LEVEL ? MAX_ASSIST_LEVEL : ((level + 1) as AssistLevel));
}

// WHY (scaffolding-with-fading): the level on a continuing turn comes from the
// evaluator's own JSON, which is free to jump 0 -> 2 in one turn. That skips the light
// hint the ladder exists to spend first, and because the level is a running max and
// ASSISTED_PASS_THRESHOLD is 2, one such jump silently forecloses a clean pass for the
// rest of the session. Mid-conversation a self-reported level may rise by one rung per
// turn, the same as `escalate` grants.
// WHY only mid-conversation: on a pass the reported level is the evaluator's accounting
// of the help it gave across the whole exchange, and clamping THAT would relabel an
// assisted pass as a clean one — laundering the record rather than pacing the ladder.
export function cappedAssistLevel(reported: AssistLevel, priorLevel: AssistLevel): AssistLevel {
  const claimed = Math.max(reported, priorLevel) as AssistLevel;
  return Math.min(claimed, escalate(priorLevel)) as AssistLevel;
}

export function currentAssistLevel(turns: EvalTurn[]): AssistLevel {
  let level: AssistLevel = 0;
  for (const turn of turns) {
    if (turn.role === 'evaluator' && turn.assistLevel !== null && turn.assistLevel > level) {
      level = turn.assistLevel;
    }
  }
  return level;
}

export type LadderOutcome = {
  verdict: EvalVerdict;
  mode: EvalTurn['mode'];
  hinted: boolean;
};

// WHY (scaffolding-with-fading): a struggling answer is not allowed to become a
// failure until the hint ladder has actually been climbed â€” levels 1..3 are
// spent as hints first, and only an exhausted ladder produces `fail`. A pass
// bought with heavy hints is recorded as `assisted-pass` so F7 reviews it sooner.
export function applyHintLadder(
  verdict: EvalVerdict,
  priorLevel: AssistLevel,
  assistedPassThreshold: number = ASSISTED_PASS_THRESHOLD,
): LadderOutcome {
  if (verdict.outcome === 'pass' || verdict.outcome === 'assisted-pass') {
    const level = Math.max(verdict.assistLevel, priorLevel) as AssistLevel;
    const outcome: EvalVerdict['outcome'] = level >= assistedPassThreshold ? 'assisted-pass' : 'pass';
    return {
      verdict: { ...verdict, outcome, assistLevel: level },
      mode: 'verdict',
      hinted: level > 0,
    };
  }

  if (verdict.outcome === 'fail' && priorLevel < MAX_ASSIST_LEVEL) {
    const level = escalate(priorLevel);
    return {
      verdict: { ...verdict, outcome: 'continue', assistLevel: level },
      mode: 'hint',
      hinted: true,
    };
  }

  if (verdict.outcome === 'fail') {
    return { verdict: { ...verdict, assistLevel: MAX_ASSIST_LEVEL }, mode: 'verdict', hinted: true };
  }

  const level = cappedAssistLevel(verdict.assistLevel, priorLevel);
  return { verdict: { ...verdict, assistLevel: level }, mode: 'question', hinted: false };
}

// WHY (F4 AC): a failed attempt always explains the specific misunderstanding
// before the next question, so a fail/hint reply that names none is prefixed
// with the one the evaluator recorded rather than being sent bare.
export function withExplanation(reply: string, verdict: EvalVerdict): string {
  if (verdict.outcome === 'pass' || verdict.outcome === 'assisted-pass') return reply;
  if (verdict.misunderstanding === null || verdict.misunderstanding.trim().length === 0) return reply;
  if (reply.includes(verdict.misunderstanding.trim())) return reply;
  return `${verdict.misunderstanding.trim()}\n\n${reply}`;
}
