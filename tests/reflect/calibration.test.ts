// FRACTAL: covers F10 | type integration
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, closeStore, type Store } from '@/store/open';
import {
  calibrationSchema,
  exampleEvalSession,
  exampleEvalTurn,
  exampleModuleId,
  examplePrediction,
  exampleSelfAssessment,
  type EvalSession,
  type EvalTurn,
} from '@/shapes';
import { nowIso, recordPrediction, skipPrediction } from '@/reflect/prediction';
import {
  ALIGNED_NOTE,
  DIVERGED_NOTE,
  PLAIN_NOTE,
  calibrationFor,
  computeCalibration,
  highestAssistLevel,
  selfAssessmentPairs,
} from '@/reflect/calibration';

const GRADE_RE = /\b[A-F][+-]?\b|\d/;

function sessionWith(turns: EvalTurn[]): EvalSession {
  return { ...exampleEvalSession, moduleId: exampleModuleId, status: 'passed', turns };
}

describe('calibration', () => {
  let dataRoot: string;
  let store: Store;

  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-calib-'));
    store = openStore(dataRoot);
  });

  afterEach(() => {
    closeStore(dataRoot);
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('includes the self-assessment comparison when self-assessments exist', () => {
    recordPrediction(store, { ...examplePrediction, moduleId: exampleModuleId });
    const turns: EvalTurn[] = [
      {
        ...exampleEvalTurn,
        id: 'l1',
        role: 'learner',
        assistLevel: null,
        mode: 'teach-back',
        selfAssessment: { ...exampleSelfAssessment, confidence: 5 },
        at: nowIso(),
      },
      {
        ...exampleEvalTurn,
        id: 'e1',
        role: 'evaluator',
        assistLevel: 3,
        mode: 'explanation',
        selfAssessment: null,
        at: nowIso(),
      },
      {
        ...exampleEvalTurn,
        id: 'l2',
        role: 'learner',
        assistLevel: 1,
        mode: 'teach-back',
        selfAssessment: { ...exampleSelfAssessment, confidence: 4 },
        at: nowIso(),
      },
    ];

    const stored = computeCalibration(store, exampleModuleId, sessionWith(turns));
    expect(stored).not.toBeNull();
    expect(calibrationSchema.safeParse(stored).success).toBe(true);
    expect(stored?.selfVsEvaluator).toEqual([
      { turnId: 'l1', self: 5, evaluatorAssist: 3 },
      { turnId: 'l2', self: 4, evaluatorAssist: 1 },
    ]);
    expect(highestAssistLevel(sessionWith(turns))).toBe(3);

    const view = calibrationFor(store, exampleModuleId);
    expect(view).not.toBeNull();
    expect(view?.selfVsEvaluator).toHaveLength(2);
    expect(view?.selfVsEvaluator[0]).toEqual({
      turnLabel: 'first answer',
      selfLabel: 'very confident',
      evaluatorLabel: 'needed it walked through',
    });
    expect(view?.selfVsEvaluator[1].turnLabel).toBe('second answer');
    expect(view?.note).toBe(DIVERGED_NOTE);
  });

  it('is silent — not an empty section — when no self-assessments were given', () => {
    recordPrediction(store, { ...examplePrediction, moduleId: exampleModuleId, confidence: 2 });
    const turns: EvalTurn[] = [
      { ...exampleEvalTurn, id: 'e1', role: 'evaluator', assistLevel: 3, mode: 'hint', at: nowIso() },
    ];
    const stored = computeCalibration(store, exampleModuleId, sessionWith(turns));
    expect(stored?.selfVsEvaluator).toEqual([]);
    const view = calibrationFor(store, exampleModuleId);
    expect(view?.selfVsEvaluator).toEqual([]);
    expect(view?.predictedLabel).toBe('shaky on this');
    expect(view?.note).toBe(ALIGNED_NOTE);
  });

  it('renders nothing at all when there is neither a prediction nor a self-assessment', () => {
    expect(computeCalibration(store, exampleModuleId, sessionWith([]))).toBeNull();
    expect(calibrationFor(store, exampleModuleId)).toBeNull();

    skipPrediction(store, exampleModuleId);
    const turns: EvalTurn[] = [
      { ...exampleEvalTurn, id: 'e1', role: 'evaluator', assistLevel: 2, mode: 'hint', at: nowIso() },
    ];
    expect(computeCalibration(store, exampleModuleId, sessionWith(turns))).toBeNull();
    expect(calibrationFor(store, exampleModuleId)).toBeNull();
  });

  it('still compares self-assessments when the prediction was skipped', () => {
    skipPrediction(store, exampleModuleId);
    const turns: EvalTurn[] = [
      {
        ...exampleEvalTurn,
        id: 'l1',
        role: 'learner',
        assistLevel: 0,
        mode: 'teach-back',
        selfAssessment: { ...exampleSelfAssessment, confidence: 5 },
        at: nowIso(),
      },
    ];
    const stored = computeCalibration(store, exampleModuleId, sessionWith(turns));
    expect(stored?.predicted).toBeNull();
    const view = calibrationFor(store, exampleModuleId);
    expect(view?.predictedLabel).toBeNull();
    expect(view?.selfVsEvaluator).toHaveLength(1);
    expect(view?.note).toBe(PLAIN_NOTE);
  });

  it('contains no number and no letter grade in any rendered field', () => {
    recordPrediction(store, { ...examplePrediction, moduleId: exampleModuleId, confidence: 5 });
    const turns: EvalTurn[] = [
      {
        ...exampleEvalTurn,
        id: 'l1',
        role: 'learner',
        assistLevel: 2,
        mode: 'teach-back',
        selfAssessment: { ...exampleSelfAssessment, confidence: 1 },
        at: nowIso(),
      },
    ];
    computeCalibration(store, exampleModuleId, sessionWith(turns));
    const view = calibrationFor(store, exampleModuleId);
    expect(view).not.toBeNull();
    const strings = [
      view!.predictedLabel ?? '',
      view!.actualLabel,
      view!.note,
      ...view!.selfVsEvaluator.flatMap((r) => [r.turnLabel, r.selfLabel, r.evaluatorLabel]),
    ];
    for (const s of strings) {
      expect(s).not.toMatch(GRADE_RE);
    }
  });

  it('pairs a self-assessment with the evaluator assist that follows it', () => {
    const pairs = selfAssessmentPairs(
      sessionWith([
        {
          ...exampleEvalTurn,
          id: 'l1',
          role: 'learner',
          assistLevel: null,
          selfAssessment: { ...exampleSelfAssessment, confidence: 2 },
          at: nowIso(),
        },
        { ...exampleEvalTurn, id: 'e1', role: 'evaluator', assistLevel: 1, at: nowIso() },
      ]),
    );
    expect(pairs).toEqual([{ turnId: 'l1', self: 2, evaluatorAssist: 1 }]);
    expect(selfAssessmentPairs(null)).toEqual([]);
    expect(highestAssistLevel(null)).toBe(0);
  });
});
