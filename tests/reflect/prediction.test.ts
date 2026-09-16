// FRACTAL: covers F10 | type unit
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, closeStore, type Store } from '@/store/open';
import { examplePrediction, exampleModuleId, predictionSchema, type ModuleId } from '@/shapes';
import {
  CONFIDENCE_LEVELS,
  PREDICTION_SKIP_LABEL,
  confidenceLabel,
  nowIso,
  predictionFor,
  predictionPrompt,
  recordPrediction,
  skipPrediction,
} from '@/reflect/prediction';
import { calibrationFor, computeCalibration } from '@/reflect/calibration';

const otherModuleId = 'm_0d9fQ2xK4mZa71bC' as ModuleId;

describe('prediction', () => {
  let dataRoot: string;
  let store: Store;

  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-pred-'));
    store = openStore(dataRoot);
  });

  afterEach(() => {
    closeStore(dataRoot);
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('records a prediction and reads it back (happy path)', () => {
    const saved = recordPrediction(store, examplePrediction);
    expect(saved).toEqual(examplePrediction);
    expect(predictionSchema.safeParse(saved).success).toBe(true);
    const round = predictionFor(store, exampleModuleId);
    expect(round).not.toBeNull();
    expect(round?.confidence).toBe(examplePrediction.confidence);
    expect(round?.expectation).toBe(examplePrediction.expectation);
    expect(round?.skipped).toBe(false);
  });

  it('offers a skippable, non-blocking prompt with a five-point control', () => {
    const prompt = predictionPrompt(store, exampleModuleId);
    expect(prompt.blocking).toBe(false);
    expect(prompt.skipLabel).toBe(PREDICTION_SKIP_LABEL);
    expect(prompt.options).toHaveLength(5);
    expect(prompt.options.map((o) => o.value)).toEqual([...CONFIDENCE_LEVELS]);
    expect(prompt.existing).toBeNull();
    expect(prompt.question.length).toBeGreaterThan(0);
    for (const option of prompt.options) {
      expect(option.label).toBe(confidenceLabel(option.value));
      expect(option.label).not.toMatch(/\d/);
    }
  });

  it('never blocks module entry: skipping records skipped=true and shows nothing downstream', () => {
    const skipped = skipPrediction(store, exampleModuleId);
    expect(skipped.skipped).toBe(true);
    expect(predictionFor(store, exampleModuleId)?.skipped).toBe(true);
    expect(computeCalibration(store, exampleModuleId, null)).toBeNull();
    expect(calibrationFor(store, exampleModuleId)).toBeNull();
    const prompt = predictionPrompt(store, exampleModuleId);
    expect(prompt.blocking).toBe(false);
    expect(prompt.existing?.skipped).toBe(true);
  });

  it('shows a wildly miscalibrated prediction plainly, with no judgment and no grade', () => {
    recordPrediction(store, {
      moduleId: otherModuleId,
      confidence: 5,
      expectation: 'I have got this cold.',
      skipped: false,
      at: nowIso(),
    });
    const calibration = computeCalibration(store, otherModuleId, {
      id: 's_4mZa71bC0d9fQ2xK' as never,
      moduleId: otherModuleId,
      kind: 'module',
      turns: [
        {
          id: 'e1',
          role: 'evaluator',
          text: 'Here is the walkthrough.',
          assistLevel: 3,
          angle: null,
          mode: 'explanation',
          selfAssessment: null,
          at: nowIso(),
        },
      ],
      consecutiveFailures: 0,
      status: 'passed',
      openedAt: nowIso(),
    });
    expect(calibration).not.toBeNull();
    const view = calibrationFor(store, otherModuleId);
    expect(view).not.toBeNull();
    expect(view?.predictedLabel).toBe('very confident');
    expect(view?.actualLabel).toBe('needed it walked through');
    expect(view?.note).toBe('Worth noticing where the two differed.');
    expect(view?.note).not.toMatch(/wrong|bad|fail|overconfident/i);
  });

  it('degrades silently when the prediction save fails and never blocks entry', () => {
    const brokenStore = {
      ...store,
      predictions: {
        get: () => null,
        upsert: () => {
          throw new Error('disk gone');
        },
      },
    } as unknown as Store;

    const returned = recordPrediction(brokenStore, examplePrediction);
    expect(returned.moduleId).toBe(examplePrediction.moduleId);
    expect(predictionFor(brokenStore, exampleModuleId)).toBeNull();
    expect(computeCalibration(brokenStore, exampleModuleId, null)).toBeNull();
  });

  it('rejects a malformed prediction rather than widening the shape', () => {
    expect(() =>
      recordPrediction(store, { ...examplePrediction, confidence: 9 } as never),
    ).toThrowError();
  });
});
