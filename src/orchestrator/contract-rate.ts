// FRACTAL: implements F2, F12 | component C4
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { nowIso } from '@/orchestrator/ids';
import type { SessionKind } from '@/cli/prompt';

// WHY: the output contract in buildPrompt is a claim — that telling a session the
// exact shape to reply with is what stops the result being refused downstream. The
// only way to know whether it holds is to count outcomes over many real sessions,
// so every authoring attempt is recorded here. This is an analysis trail, NOT a
// product surface: nothing reads it back, no route exposes it, and a write that
// fails is swallowed rather than allowed to break an authoring run that otherwise
// succeeded.

export type ContractOutcome =
  | 'clean' // parsed first try, no field had to be coerced
  | 'coerced' // parsed, but the validator repaired at least one field
  | 'invalid-content' // came back in a shape the validator could not save
  | 'dispatch-failed'; // never got as far as content — timeout, cancel, refusal

export type ContractRateSample = {
  outcome: ContractOutcome;
  kind: SessionKind;
  coercions: string[];
  durationMs: number;
  /**
   * Rounds of contract patching this attempt needed: 0 when the first answer parsed.
   * WHY it is here and not a new `outcome`: a lesson that landed on the second round is
   * still a contract the prompt failed to state clearly enough, and folding those into
   * `clean` would let the patch loop quietly repair the very evidence this file exists to
   * collect.
   */
  patchRounds?: number;
  code?: string;
};

export type ContractRateTotals = {
  attempts: number;
  clean: number;
  coerced: number;
  invalidContent: number;
  dispatchFailed: number;
};

const totals: ContractRateTotals = {
  attempts: 0,
  clean: 0,
  coerced: 0,
  invalidContent: 0,
  dispatchFailed: 0,
};

const FIELD_KEY = {
  clean: 'clean',
  coerced: 'coerced',
  'invalid-content': 'invalidContent',
  'dispatch-failed': 'dispatchFailed',
} as const;

export function recordContractOutcome(dataRoot: string, sample: ContractRateSample): void {
  totals.attempts += 1;
  totals[FIELD_KEY[sample.outcome]] += 1;

  const line = JSON.stringify({
    at: nowIso(),
    outcome: sample.outcome,
    kind: sample.kind,
    // WHY: the coerced FIELD NAMES, not their values — which field the model gets
    // wrong is the thing worth analysing, and the values are learner-facing content.
    coercionCount: sample.coercions.length,
    coercions: sample.coercions,
    durationMs: sample.durationMs,
    ...(sample.patchRounds === undefined ? {} : { patchRounds: sample.patchRounds }),
    ...(sample.code === undefined ? {} : { code: sample.code }),
  });

  try {
    const dir = path.join(path.resolve(dataRoot), 'metrics');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'contract-rate.ndjson'), `${line}\n`);
  } catch {
    // deliberately silent — see the note at the top of this file
  }
}

export function contractRateTotals(): ContractRateTotals {
  return { ...totals };
}

export function resetContractRateTotals(): void {
  totals.attempts = 0;
  totals.clean = 0;
  totals.coerced = 0;
  totals.invalidContent = 0;
  totals.dispatchFailed = 0;
}
