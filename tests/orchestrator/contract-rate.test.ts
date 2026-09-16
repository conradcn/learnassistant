// FRACTAL: covers F2 | type unit | path contract-rate-recorded
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  contractRateTotals,
  recordContractOutcome,
  resetContractRateTotals,
} from '@/orchestrator/contract-rate';

let dataRoot: string;

function samples(): Record<string, unknown>[] {
  const file = path.join(dataRoot, 'metrics', 'contract-rate.ndjson');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-rate-'));
  resetContractRateTotals();
});

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('authoring contract rate tracking', () => {
  it('counts each outcome and appends one line per attempt', () => {
    recordContractOutcome(dataRoot, { outcome: 'clean', kind: 'author-module', coercions: [], durationMs: 10 });
    recordContractOutcome(dataRoot, {
      outcome: 'coerced',
      kind: 'detour',
      coercions: ['explanation.video -> text'],
      durationMs: 20,
    });
    recordContractOutcome(dataRoot, {
      outcome: 'invalid-content',
      kind: 'author-module',
      coercions: [],
      durationMs: 30,
      code: 'invalid-content',
    });

    expect(contractRateTotals()).toEqual({
      attempts: 3,
      clean: 1,
      coerced: 1,
      invalidContent: 1,
      dispatchFailed: 0,
    });
    const written = samples();
    expect(written).toHaveLength(3);
    expect(written[1].coercionCount).toBe(1);
    expect(written[1].kind).toBe('detour');
  });

  it('never throws when the metrics directory cannot be written', () => {
    const unwritable = path.join(dataRoot, 'not-a-dir.txt', 'nested');
    expect(() => recordContractOutcome(unwritable, { outcome: 'dispatch-failed', kind: 'author-module', coercions: [], durationMs: 1, code: 'timeout' })).not.toThrow();
    expect(contractRateTotals().dispatchFailed).toBe(1);
  });
});
