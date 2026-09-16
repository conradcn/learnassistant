// FRACTAL: implements F4 | component C6
import type { EvalScript, EvalTurn, EvalVerdict, TeachBackMisconception } from '@/shapes';

export const TEACH_BACK_ANGLE = 'teach-back';
export const IDENTIFY_OVERLAP = 0.34;
export const CORRECT_OVERLAP = 0.34;

function contentWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);
}

function overlap(claim: string, answer: string): number {
  const words = contentWords(claim);
  if (words.length === 0) return 0;
  const said = new Set(contentWords(answer));
  return words.filter((w) => said.has(w)).length / words.length;
}

export function usedMisconceptionIds(turns: EvalTurn[]): string[] {
  return turns
    .filter((t) => t.role === 'evaluator' && t.mode === 'teach-back' && t.angle !== null)
    .map((t) => t.angle as string)
    .map((a) => a.slice(TEACH_BACK_ANGLE.length + 1))
    .filter((id) => id.length > 0);
}

export function angleForMisconception(m: TeachBackMisconception): string {
  return `${TEACH_BACK_ANGLE}:${m.id}`;
}

export function selectMisconception(script: EvalScript, turns: EvalTurn[]): TeachBackMisconception | null {
  const used = new Set(usedMisconceptionIds(turns));
  return script.misconceptions.find((m) => !used.has(m.id)) ?? null;
}

// WHY (protégé effect): the evaluator takes the confused-student role and states
// the planted misconception as its own belief. The correction is never included
// in the prompt — the learner has to supply it, which is the whole point.
export function teachBackPrompt(m: TeachBackMisconception): string {
  return [
    'Let me try explaining this back to you, and you tell me where I have gone wrong.',
    '',
    `Here is how I understand it: ${m.statement}`,
    '',
    'Which part of that is wrong, and what is the right way to put it?',
  ].join('\n');
}

export type TeachBackAssessment = {
  identified: boolean;
  corrected: boolean;
  passed: boolean;
};

// WHY (F4 AC): a teach-back exchange passes only if the learner both names the
// planted misconception and states the correction, so the model's verdict is
// cross-checked against the learner's own words rather than taken on trust.
export function assessTeachBack(answer: string, m: TeachBackMisconception): TeachBackAssessment {
  const identified = overlap(m.statement, answer) >= IDENTIFY_OVERLAP;
  const corrected = overlap(m.correction, answer) >= CORRECT_OVERLAP;
  return { identified, corrected, passed: identified && corrected };
}

export function gateTeachBackVerdict(
  verdict: EvalVerdict,
  answer: string,
  m: TeachBackMisconception,
): { verdict: EvalVerdict; assessment: TeachBackAssessment } {
  const assessment = assessTeachBack(answer, m);
  if (verdict.outcome !== 'pass' && verdict.outcome !== 'assisted-pass') {
    return { verdict, assessment };
  }
  if (assessment.passed) return { verdict, assessment };
  return {
    verdict: {
      ...verdict,
      outcome: 'continue',
      misunderstanding: assessment.identified
        ? 'You spotted the wrong part, but the corrected version is still missing.'
        : 'That has not yet named which part of my explanation is wrong.',
      rationale: 'The planted misconception was not both named and corrected.',
    },
    assessment,
  };
}
