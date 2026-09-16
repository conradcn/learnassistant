// FRACTAL: implements F5, F1, F13 | component C1
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  topicIdSchema,
  topicSchema,
  type Topic,
  type TopicId,
  type Level,
  type DiagnosticTranscript,
  type TopicNote,
} from '@/shapes';
import { err } from '@/core/errors';

export type NewTopic = {
  subject: string;
  level: Level;
  levelDetail?: string;
  purpose: string;
  diagnostic: DiagnosticTranscript | null;
  // WHY: the same subject at the same level is a duplicate by default, but it is a
  // legitimate thing to want a second time (a re-run, a fresh start). The refusal is
  // therefore a question the learner can answer, not a wall — the intake screen sets
  // this once it has asked.
  allowDuplicate?: boolean;
};

export type DegradedTopic = {
  degraded: true;
  id: TopicId;
  reason: string;
  rawPreview: string;
};

export type TopicsRepo = {
  create(input: NewTopic): Topic;
  get(id: TopicId): Topic | DegradedTopic | null;
  list(): (Topic | DegradedTopic)[];
  delete(id: TopicId): void;
  /**
   * WHY the one update the row allows (F1): the diagnostic is intake, which the row owns,
   * but it is a conversation held after the topic exists — the session needs the topic's
   * folder to run in. It is saved every turn so a learner who walks away mid-chat still
   * leaves behind what they had shown.
   */
  setDiagnostic(id: TopicId, diagnostic: DiagnosticTranscript): void;
};

type TopicRow = {
  id: string;
  subject: string;
  level: string;
  level_detail: string | null;
  purpose: string;
  driving_question: string | null;
  status: string;
  diagnostic_json: string | null;
  notes_json: string;
  created_at: string;
  updated_at: string;
};

function generateTopicId(): TopicId {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return topicIdSchema.parse(`t_${out}`);
}

function nowIso(): string {
  return new Date().toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');
}

function rowToTopic(row: TopicRow): Topic | DegradedTopic {
  const preview = JSON.stringify(row).slice(0, 200);
  try {
    const diagnostic = row.diagnostic_json ? JSON.parse(row.diagnostic_json) : null;
    const notes: TopicNote[] = JSON.parse(row.notes_json);
    const candidate = {
      id: row.id,
      subject: row.subject,
      level: row.level,
      levelDetail: row.level_detail ?? undefined,
      purpose: row.purpose,
      drivingQuestion: row.driving_question,
      status: row.status,
      diagnostic,
      notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    const parsed = topicSchema.safeParse(candidate);
    if (!parsed.success) {
      return { degraded: true, id: topicIdSchema.parse(row.id), reason: 'topic row failed shape validation', rawPreview: preview };
    }
    return parsed.data;
  } catch {
    return { degraded: true, id: topicIdSchema.parse(row.id), reason: 'topic row JSON failed to parse', rawPreview: preview };
  }
}

export function createTopicsRepo(db: Database.Database): TopicsRepo {
  const insertStmt = db.prepare(`
    INSERT INTO topics (id, subject, level, level_detail, purpose, driving_question, status, diagnostic_json, notes_json, created_at, updated_at)
    VALUES (@id, @subject, @level, @levelDetail, @purpose, @drivingQuestion, @status, @diagnosticJson, @notesJson, @createdAt, @updatedAt)
  `);
  const getStmt = db.prepare('SELECT * FROM topics WHERE id = ?');
  const listStmt = db.prepare('SELECT * FROM topics ORDER BY created_at ASC');
  const findBySubjectLevelStmt = db.prepare('SELECT id FROM topics WHERE subject = ? AND level = ?');
  // The learner-data tables below are keyed on a module id, not a topic id, so each one
  // resolves its rows through the topic's modules. That is why they all have to run before
  // `module_nodes` is emptied: the subquery is the only link back to the subject.
  const MODULES_OF_TOPIC = 'SELECT id FROM module_nodes WHERE topic_id = ?';
  const deleteEvalTurnsStmt = db.prepare(
    `DELETE FROM eval_turns WHERE session_id IN (SELECT id FROM eval_sessions WHERE module_id IN (${MODULES_OF_TOPIC}))`,
  );
  const deleteEvalSessionsStmt = db.prepare(`DELETE FROM eval_sessions WHERE module_id IN (${MODULES_OF_TOPIC})`);
  const deleteReviewItemsStmt = db.prepare(`DELETE FROM review_items WHERE module_id IN (${MODULES_OF_TOPIC})`);
  const deletePredictionsStmt = db.prepare(`DELETE FROM predictions WHERE module_id IN (${MODULES_OF_TOPIC})`);
  const deleteCalibrationStmt = db.prepare(`DELETE FROM calibration WHERE module_id IN (${MODULES_OF_TOPIC})`);
  const deleteJobsStmt = db.prepare('DELETE FROM jobs WHERE topic_id = ?');
  const deleteModuleNodesStmt = db.prepare('DELETE FROM module_nodes WHERE topic_id = ?');
  const deletePrereqEdgesStmt = db.prepare('DELETE FROM prereq_edges WHERE topic_id = ?');
  const deleteEntryStmt = db.prepare('DELETE FROM module_graph_entry WHERE topic_id = ?');
  const deleteCapstoneSubmissionsStmt = db.prepare('DELETE FROM capstone_submissions WHERE topic_id = ?');
  const deleteCapstonesStmt = db.prepare('DELETE FROM capstones WHERE topic_id = ?');
  const deleteReflectionsStmt = db.prepare('DELETE FROM reflections WHERE topic_id = ?');
  const deleteSourcesStmt = db.prepare('DELETE FROM source_documents WHERE topic_id = ?');
  const deleteTopicStmt = db.prepare('DELETE FROM topics WHERE id = ?');
  const setDiagnosticStmt = db.prepare('UPDATE topics SET diagnostic_json = ?, updated_at = ? WHERE id = ?');

  const deleteTx = db.transaction((id: string) => {
    // WHY these come first: a transcript of what the learner said, what they predicted and
    // how they were graded is the most personal thing the store holds, and it hangs off
    // module ids that reference nothing once the modules are gone. Deleting the subject
    // has to take it, or the rows survive forever with nothing left to find them by.
    deleteEvalTurnsStmt.run(id);
    deleteEvalSessionsStmt.run(id);
    deleteReviewItemsStmt.run(id);
    deletePredictionsStmt.run(id);
    deleteCalibrationStmt.run(id);
    deleteJobsStmt.run(id);
    deleteModuleNodesStmt.run(id);
    deletePrereqEdgesStmt.run(id);
    deleteEntryStmt.run(id);
    deleteCapstoneSubmissionsStmt.run(id);
    deleteCapstonesStmt.run(id);
    deleteReflectionsStmt.run(id);
    // The index goes with the topic; the extracted text and the original upload under
    // `topics/<id>/source/` are removed by C9 in the same request, because the learner's
    // own document is the one thing under `topics/` that must not outlive the subject.
    deleteSourcesStmt.run(id);
    deleteTopicStmt.run(id);
  });

  return {
    create(input: NewTopic): Topic {
      if (input.subject.trim().length === 0) {
        throw err('validation', { detail: 'subject is required to create a topic' });
      }
      const existing = input.allowDuplicate === true ? undefined : findBySubjectLevelStmt.get(input.subject, input.level);
      if (existing) {
        throw err('conflict', { detail: 'a topic with this subject and level already exists' });
      }
      const id = generateTopicId();
      const at = nowIso();
      const topic: Topic = {
        id,
        subject: input.subject,
        level: input.level,
        levelDetail: input.levelDetail,
        purpose: input.purpose,
        drivingQuestion: null,
        status: 'queued',
        diagnostic: input.diagnostic,
        notes: [],
        createdAt: at as Topic['createdAt'],
        updatedAt: at as Topic['updatedAt'],
      };
      insertStmt.run({
        id: topic.id,
        subject: topic.subject,
        level: topic.level,
        levelDetail: topic.levelDetail ?? null,
        purpose: topic.purpose,
        drivingQuestion: topic.drivingQuestion,
        status: topic.status,
        diagnosticJson: topic.diagnostic ? JSON.stringify(topic.diagnostic) : null,
        notesJson: JSON.stringify(topic.notes),
        createdAt: topic.createdAt,
        updatedAt: topic.updatedAt,
      });
      return topic;
    },

    get(id: TopicId): Topic | DegradedTopic | null {
      const row = getStmt.get(id) as TopicRow | undefined;
      if (!row) return null;
      return rowToTopic(row);
    },

    list(): (Topic | DegradedTopic)[] {
      const rows = listStmt.all() as TopicRow[];
      return rows.map(rowToTopic);
    },

    delete(id: TopicId): void {
      deleteTx(id);
    },

    setDiagnostic(id: TopicId, diagnostic: DiagnosticTranscript): void {
      setDiagnosticStmt.run(JSON.stringify(diagnostic), nowIso(), id);
    },
  };
}
