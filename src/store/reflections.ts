// FRACTAL: implements F5, F1, F13 | component C1
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  calibrationSchema,
  moduleIdSchema,
  predictionSchema,
  reflectionSchema,
  topicIdSchema,
  type AssistLevel,
  type Calibration,
  type Prediction,
  type Reflection,
  type TopicId,
} from '@/shapes';
import { err } from '@/core/errors';

export type ReflectionsRepo = {
  create(input: Omit<Reflection, 'id' | 'createdAt' | 'updatedAt'>): Reflection;
  get(id: string): Reflection | null;
  listByTopic(topicId: TopicId): Reflection[];
  listAll(): Reflection[];
  update(id: string, text: string): Reflection;
  delete(id: string): void;
};

export type PredictionsRepo = {
  upsert(p: Prediction): void;
  get(moduleId: string): Prediction | null;
};

export type CalibrationRepo = {
  upsert(c: Calibration): void;
  get(moduleId: string): Calibration | null;
};

type ReflectionRow = {
  id: string;
  topic_id: string;
  module_id: string | null;
  text: string;
  created_at: string;
  updated_at: string;
};

function rowToReflection(row: ReflectionRow): Reflection {
  return {
    id: row.id,
    topicId: topicIdSchema.parse(row.topic_id),
    moduleId: row.module_id ? moduleIdSchema.parse(row.module_id) : null,
    text: row.text,
    createdAt: row.created_at as Reflection['createdAt'],
    updatedAt: row.updated_at as Reflection['updatedAt'],
  };
}

function nowIso(): string {
  return new Date().toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');
}

function generateReflectionId(): string {
  return `r_${randomBytes(8).toString('hex')}`;
}

export function createReflectionsRepo(db: Database.Database): ReflectionsRepo {
  const insertStmt = db.prepare(`
    INSERT INTO reflections (id, topic_id, module_id, text, created_at, updated_at)
    VALUES (@id, @topicId, @moduleId, @text, @createdAt, @updatedAt)
  `);
  const getStmt = db.prepare('SELECT * FROM reflections WHERE id = ?');
  const listByTopicStmt = db.prepare('SELECT * FROM reflections WHERE topic_id = ? ORDER BY created_at ASC');
  const listAllStmt = db.prepare('SELECT * FROM reflections ORDER BY created_at ASC');
  const updateStmt = db.prepare('UPDATE reflections SET text = ?, updated_at = ? WHERE id = ?');
  const deleteStmt = db.prepare('DELETE FROM reflections WHERE id = ?');

  return {
    create(input: Omit<Reflection, 'id' | 'createdAt' | 'updatedAt'>): Reflection {
      const at = nowIso();
      const reflection: Reflection = {
        id: generateReflectionId(),
        topicId: input.topicId,
        moduleId: input.moduleId,
        text: input.text,
        createdAt: at as Reflection['createdAt'],
        updatedAt: at as Reflection['updatedAt'],
      };
      const parsed = reflectionSchema.safeParse(reflection);
      if (!parsed.success) {
        throw err('validation', { detail: 'reflection failed shape validation' });
      }
      insertStmt.run({
        id: parsed.data.id,
        topicId: parsed.data.topicId,
        moduleId: parsed.data.moduleId,
        text: parsed.data.text,
        createdAt: parsed.data.createdAt,
        updatedAt: parsed.data.updatedAt,
      });
      return parsed.data;
    },

    get(id: string): Reflection | null {
      const row = getStmt.get(id) as ReflectionRow | undefined;
      return row ? rowToReflection(row) : null;
    },

    listByTopic(topicId: TopicId): Reflection[] {
      return (listByTopicStmt.all(topicId) as ReflectionRow[]).map(rowToReflection);
    },

    listAll(): Reflection[] {
      return (listAllStmt.all() as ReflectionRow[]).map(rowToReflection);
    },

    update(id: string, text: string): Reflection {
      const at = nowIso();
      const result = updateStmt.run(text, at, id);
      if (result.changes === 0) {
        throw err('not-found', { detail: 'reflection not found for update' });
      }
      const row = getStmt.get(id) as ReflectionRow;
      return rowToReflection(row);
    },

    delete(id: string): void {
      deleteStmt.run(id);
    },
  };
}

type PredictionRow = {
  module_id: string;
  confidence: number;
  expectation: string;
  skipped: number;
  at: string;
};

export function createPredictionsRepo(db: Database.Database): PredictionsRepo {
  const upsertStmt = db.prepare(`
    INSERT INTO predictions (module_id, confidence, expectation, skipped, at)
    VALUES (@moduleId, @confidence, @expectation, @skipped, @at)
    ON CONFLICT(module_id) DO UPDATE SET
      confidence = excluded.confidence,
      expectation = excluded.expectation,
      skipped = excluded.skipped,
      at = excluded.at
  `);
  const getStmt = db.prepare('SELECT * FROM predictions WHERE module_id = ?');

  return {
    upsert(p: Prediction): void {
      const parsed = predictionSchema.safeParse(p);
      if (!parsed.success) {
        throw err('validation', { detail: 'prediction failed shape validation' });
      }
      upsertStmt.run({
        moduleId: parsed.data.moduleId,
        confidence: parsed.data.confidence,
        expectation: parsed.data.expectation,
        skipped: parsed.data.skipped ? 1 : 0,
        at: parsed.data.at,
      });
    },
    get(moduleId: string): Prediction | null {
      const row = getStmt.get(moduleId) as PredictionRow | undefined;
      if (!row) return null;
      return {
        moduleId: moduleIdSchema.parse(row.module_id),
        confidence: row.confidence as Prediction['confidence'],
        expectation: row.expectation,
        skipped: row.skipped === 1,
        at: row.at as Prediction['at'],
      };
    },
  };
}

type CalibrationRow = {
  module_id: string;
  predicted: number | null;
  actual_assist_level: number;
  self_vs_evaluator_json: string;
};

export function createCalibrationRepo(db: Database.Database): CalibrationRepo {
  const upsertStmt = db.prepare(`
    INSERT INTO calibration (module_id, predicted, actual_assist_level, self_vs_evaluator_json)
    VALUES (@moduleId, @predicted, @actualAssistLevel, @selfVsEvaluatorJson)
    ON CONFLICT(module_id) DO UPDATE SET
      predicted = excluded.predicted,
      actual_assist_level = excluded.actual_assist_level,
      self_vs_evaluator_json = excluded.self_vs_evaluator_json
  `);
  const getStmt = db.prepare('SELECT * FROM calibration WHERE module_id = ?');

  return {
    upsert(c: Calibration): void {
      const parsed = calibrationSchema.safeParse(c);
      if (!parsed.success) {
        throw err('validation', { detail: 'calibration failed shape validation' });
      }
      upsertStmt.run({
        moduleId: parsed.data.moduleId,
        predicted: parsed.data.predicted,
        actualAssistLevel: parsed.data.actualAssistLevel,
        selfVsEvaluatorJson: JSON.stringify(parsed.data.selfVsEvaluator),
      });
    },
    get(moduleId: string): Calibration | null {
      const row = getStmt.get(moduleId) as CalibrationRow | undefined;
      if (!row) return null;
      return {
        moduleId: moduleIdSchema.parse(row.module_id),
        predicted: row.predicted as Calibration['predicted'],
        actualAssistLevel: row.actual_assist_level as AssistLevel,
        selfVsEvaluator: JSON.parse(row.self_vs_evaluator_json),
      };
    },
  };
}
