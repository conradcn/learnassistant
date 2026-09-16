// FRACTAL: implements F4, F9 | component C6
import type { EvalScript, EvalTurn } from '@/shapes';
import { angleLedgerSchema, type AngleLedger } from '@/eval/shapes';

export const NEAR_DUPLICATE_THRESHOLD = 0.8;
export const TARGET_TAG_PREFIX = 'target:';

export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .join(' ');
}

function tokenSet(text: string): Set<string> {
  return new Set(normalizeQuestion(text).split(' ').filter((w) => w.length > 0));
}

export function similarity(a: string, b: string): number {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export function isAngleTag(angle: string | null): boolean {
  return angle !== null && angle.startsWith(TARGET_TAG_PREFIX);
}

export function priorQuestions(turns: EvalTurn[]): string[] {
  return turns
    .filter((t) => t.role === 'evaluator' && (t.mode === 'question' || t.mode === 'teach-back'))
    .map((t) => t.text);
}

// WHY it is separate from `checkReask`: a hint is scaffolding on the question the
// learner is already on, so it must not be held to "spend an unused angle" — but it
// must still not be the same words again. This is that half of the check on its own.
export function isNearDuplicate(candidate: string, asked: string[]): boolean {
  return asked.some((prior) => similarity(candidate, prior) >= NEAR_DUPLICATE_THRESHOLD);
}

// WHY: the angle a hint belongs to is the one the question it is hinting at used, so
// hint turns carry it forward rather than labelling themselves with a fresh one.
export function currentAngle(turns: EvalTurn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn.role !== 'evaluator') continue;
    if (turn.angle === null || isAngleTag(turn.angle)) continue;
    return turn.angle;
  }
  return null;
}

export function usedAngles(turns: EvalTurn[]): string[] {
  const seen: string[] = [];
  for (const turn of turns) {
    if (turn.role !== 'evaluator') continue;
    if (turn.angle === null || isAngleTag(turn.angle)) continue;
    if (!seen.includes(turn.angle)) seen.push(turn.angle);
  }
  return seen;
}

export function angleLedger(script: EvalScript, turns: EvalTurn[]): AngleLedger {
  const used = usedAngles(turns);
  const available = script.angles.filter((a) => !used.includes(a));
  return angleLedgerSchema.parse({ used, available });
}

export function chooseAngle(ledger: AngleLedger, preferred: string | null): string | null {
  if (preferred !== null && ledger.available.includes(preferred)) return preferred;
  return ledger.available[0] ?? null;
}

export type ReaskCheck =
  | { ok: true; angle: string }
  | { ok: false; reason: 'no-angles-left' | 'angle-already-used' | 'near-duplicate'; detail: string };

// WHY (F4 AC): "not a verbatim repeat" is checked, not promised — an unused
// angle is required AND the candidate text is compared against every prior
// question. The comparison is O(turns) per candidate over a transcript bounded
// at 20 exchanges, so it runs inline.
export function checkReask(
  candidate: string,
  angle: string | null,
  ledger: AngleLedger,
  asked: string[],
): ReaskCheck {
  if (angle === null) {
    return { ok: false, reason: 'no-angles-left', detail: 'every angle in this lesson has been used' };
  }
  if (ledger.used.includes(angle)) {
    return { ok: false, reason: 'angle-already-used', detail: `the angle "${angle}" was already used` };
  }
  for (const prior of asked) {
    if (similarity(candidate, prior) >= NEAR_DUPLICATE_THRESHOLD) {
      return { ok: false, reason: 'near-duplicate', detail: 'the question repeats one already asked' };
    }
  }
  return { ok: true, angle };
}
