// FRACTAL: implements F2, F12 | component C4
/**
 * The contract patch loop: ask, check the answer against the schema, and where it misses,
 * ask again naming the exact fields that were refused.
 *
 * WHY it exists: every model call in this app is dispatched with an `outputSchema` and the
 * answer is all-or-nothing — one bad field and the whole thing is thrown away. In prod
 * that showed up as an authoring session whose lesson was fine except for
 * `blocks.12.kind:invalid_union_discriminator`: twelve good blocks and one wrong
 * discriminator, the entire lesson discarded, the subject parked on `needs-attention`, and
 * the learner left with a retry button that re-ran the identical prompt and was as likely
 * to miss the same way again. The session was never told what was wrong with it.
 *
 * WHY a loop and not a retry: a retry is the same question a second time. This is a
 * different question — "here is the path you got wrong, send the object again with that
 * fixed" — which is why it converges where a retry only re-rolls.
 *
 * WHY the caller supplies both halves: the loop must not know what a lesson is. It knows
 * how to ask, how to be told an answer was refused, and when to stop; `attempt` and
 * `check` are what make it a lesson, an outline or a capstone spec.
 */

/** The verdict on one answer: the parsed value, or the paths that were refused. */
export type ContractCheck<T> = { ok: true; value: T } | { ok: false; issues: string[] };

/**
 * Rounds of correction after the first attempt. Two, because the first patch is the one
 * that carries the information — a session told which field is wrong either fixes it or is
 * missing something a third identical telling will not supply — and because every round is
 * a whole authoring session the learner is waiting through.
 */
export const MAX_CONTRACT_PATCH_ROUNDS = 2;

export type ContractPatchOutcome<A, F, T> =
  /** An answer that satisfied the schema. `rounds` is 0 when the first attempt was clean. */
  | { kind: 'valid'; answer: A; value: T; rounds: number }
  /** Answers came back, and the last one still missed the contract. */
  | { kind: 'refused'; answer: A; issues: string[]; rounds: number }
  /** No answer to check — a timeout, a cancellation, a session that would not run. */
  | { kind: 'unavailable'; failure: F; rounds: number };

export type ContractPatchRequest<A, F, T> = {
  /**
   * Ask the model. `issues` is null on the first attempt and, after that, the paths the
   * previous answer was refused on — which the caller is expected to put in front of the
   * model, or the loop is just a retry with extra steps.
   */
  attempt: (issues: string[] | null, round: number) => Promise<{ ok: true; answer: A } | { ok: false; failure: F }>;
  check: (answer: A, round: number) => ContractCheck<T>;
  /** Rounds of correction after the first attempt. Defaults to MAX_CONTRACT_PATCH_ROUNDS. */
  rounds?: number;
  /** Called for every answer that was refused, including the last one. */
  onRefused?: (issues: string[], round: number) => void;
};

export async function patchContract<A, F, T>(
  req: ContractPatchRequest<A, F, T>,
): Promise<ContractPatchOutcome<A, F, T>> {
  const rounds = req.rounds ?? MAX_CONTRACT_PATCH_ROUNDS;
  let issues: string[] | null = null;

  for (let round = 0; round <= rounds; round += 1) {
    const attempted = await req.attempt(issues, round);
    // WHY a dispatch failure ends the loop rather than spending a round: there is no answer
    // to correct, so the next round would be the same first attempt again — and the reason
    // it failed is usually the reason it would fail again. A cancelled job leaves here
    // immediately for the same reason, which is what keeps the learner's stop button honest.
    if (!attempted.ok) return { kind: 'unavailable', failure: attempted.failure, rounds: round };

    const checked = req.check(attempted.answer, round);
    if (checked.ok) return { kind: 'valid', answer: attempted.answer, value: checked.value, rounds: round };

    issues = checked.issues;
    req.onRefused?.(checked.issues, round);
    if (round === rounds) {
      return { kind: 'refused', answer: attempted.answer, issues: checked.issues, rounds: round };
    }
  }

  // Unreachable: the loop returns on its last round. Present so the ceiling is a value and
  // not a promise the type system has to take on trust.
  return { kind: 'refused', answer: undefined as A, issues: issues ?? [], rounds };
}
