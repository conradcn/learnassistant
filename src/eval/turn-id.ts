// FRACTAL: implements F4, F9, F13 | component C6
import type { EvalSession, EvalTurn, EvalVerdict } from '@/shapes';

export type TurnOutcome = EvalVerdict['outcome'] | 'abandoned';

// WHY: C1's EvalsRepo can append a turn but cannot update a session row, so the
// durable record of "what did this exchange decide" has to live on the turn
// itself. The turn id is the only free-form field that is not learner text and
// not part of the angle ledger, so it carries the outcome.
export function learnerTurnId(ordinal: number): string {
  return `l${ordinal}`;
}

export function evaluatorTurnId(ordinal: number, outcome: TurnOutcome): string {
  return `v${ordinal}:${outcome}`;
}

const OUTCOMES: TurnOutcome[] = ['pass', 'assisted-pass', 'fail', 'continue', 'abandoned'];

export function outcomeOfTurn(turn: EvalTurn): TurnOutcome | null {
  if (turn.role !== 'evaluator') return null;
  const idx = turn.id.indexOf(':');
  if (idx < 0) return null;
  const raw = turn.id.slice(idx + 1);
  return OUTCOMES.find((o) => o === raw) ?? null;
}

export function evaluatorOutcomes(turns: EvalTurn[]): TurnOutcome[] {
  return turns.map(outcomeOfTurn).filter((o): o is TurnOutcome => o !== null);
}

export function consecutiveFailuresOf(turns: EvalTurn[]): number {
  let count = 0;
  for (const outcome of [...evaluatorOutcomes(turns)].reverse()) {
    if (outcome === 'fail') count += 1;
    else break;
  }
  return count;
}

export function statusOf(turns: EvalTurn[]): EvalSession['status'] {
  const outcomes = evaluatorOutcomes(turns);
  if (outcomes.includes('abandoned')) return 'abandoned';
  if (outcomes.some((o) => o === 'pass' || o === 'assisted-pass')) return 'passed';
  return 'open';
}

// WHY: `consecutiveFailures` and `status` are stored on the session row at
// creation time and never updated, so every read derives them from the turns —
// the one record that IS written per exchange.
export function hydrateSession(session: EvalSession): EvalSession {
  return {
    ...session,
    consecutiveFailures: consecutiveFailuresOf(session.turns),
    status: statusOf(session.turns),
  };
}
