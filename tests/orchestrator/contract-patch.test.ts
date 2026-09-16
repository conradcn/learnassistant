// FRACTAL: covers F2, F12 | type unit
import { describe, expect, it, vi } from 'vitest';
import { MAX_CONTRACT_PATCH_ROUNDS, patchContract, type ContractCheck } from '@/orchestrator/contract-patch';

/** A checker that refuses the first `refusals` answers and then accepts. */
function acceptsAfter(refusals: number): (answer: string) => ContractCheck<string> {
  let seen = 0;
  return (answer: string): ContractCheck<string> => {
    seen += 1;
    return seen > refusals ? { ok: true, value: answer } : { ok: false, issues: [`blocks.${seen}.kind:invalid_union_discriminator`] };
  };
}

describe('the contract patch loop', () => {
  it('asks once and stops when the first answer already fits the schema', async () => {
    const attempt = vi.fn(async (_issues: string[] | null) => ({ ok: true as const, answer: 'good' }));
    const result = await patchContract({ attempt, check: acceptsAfter(0) });

    expect(result).toEqual({ kind: 'valid', answer: 'good', value: 'good', rounds: 0 });
    expect(attempt).toHaveBeenCalledTimes(1);
    // The first attempt is the ordinary one: nothing was refused, so there is nothing to say.
    expect(attempt.mock.calls[0][0]).toBeNull();
  });

  it('hands the refused field paths to the next attempt, and keeps the fixed answer', async () => {
    const attempt = vi.fn(async (issues: string[] | null) => ({
      ok: true as const,
      answer: issues === null ? 'first' : 'patched',
    }));
    const result = await patchContract({ attempt, check: acceptsAfter(1) });

    expect(result).toMatchObject({ kind: 'valid', value: 'patched', rounds: 1 });
    expect(attempt).toHaveBeenCalledTimes(2);
    // WHY this is the assertion that matters: without the issues reaching the second
    // attempt the loop is a retry, and a retry re-rolls the same mistake.
    expect(attempt.mock.calls[1][0]).toEqual(['blocks.1.kind:invalid_union_discriminator']);
  });

  it('gives up after its rounds and reports what was still wrong', async () => {
    const attempt = vi.fn(async () => ({ ok: true as const, answer: 'never right' }));
    const refused: number[] = [];
    const result = await patchContract({
      attempt,
      check: acceptsAfter(Number.POSITIVE_INFINITY),
      onRefused: (_issues, round) => refused.push(round),
    });

    expect(result.kind).toBe('refused');
    expect(result).toMatchObject({ rounds: MAX_CONTRACT_PATCH_ROUNDS });
    if (result.kind === 'refused') expect(result.issues).toHaveLength(1);
    // The first attempt plus every round of correction, and not one more.
    expect(attempt).toHaveBeenCalledTimes(MAX_CONTRACT_PATCH_ROUNDS + 1);
    expect(refused).toEqual([0, 1, 2]);
  });

  it('respects a tighter round budget', async () => {
    const attempt = vi.fn(async () => ({ ok: true as const, answer: 'never right' }));
    await patchContract({ attempt, check: acceptsAfter(Number.POSITIVE_INFINITY), rounds: 0 });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('stops on a session that never answered rather than spending a round on it', async () => {
    // WHY: there is no answer to correct. A cancelled or timed-out session that consumed
    // the whole budget would triple the wait before the learner is told anything.
    const attempt = vi.fn(async () => ({ ok: false as const, failure: 'cancelled' }));
    const check = vi.fn(() => ({ ok: true as const, value: 'unused' }));
    const result = await patchContract({ attempt, check });

    expect(result).toEqual({ kind: 'unavailable', failure: 'cancelled', rounds: 0 });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(check).not.toHaveBeenCalled();
  });

  it('stops mid-loop when a later round cannot dispatch', async () => {
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? { ok: true as const, answer: 'bad' } : { ok: false as const, failure: 'timeout' };
    });
    const result = await patchContract({ attempt, check: acceptsAfter(Number.POSITIVE_INFINITY) });

    expect(result).toEqual({ kind: 'unavailable', failure: 'timeout', rounds: 1 });
  });
});
