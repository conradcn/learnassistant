// FRACTAL: implements F5, F1, F13 | component C1
import type Database from 'better-sqlite3';
import {
  moduleIdSchema,
  topicIdSchema,
  type EvalVerdict,
  type ISODateString,
  type ModuleId,
  type ModuleNode,
  type ModuleState,
  type ReviewItem,
} from '@/shapes';
import { err } from '@/core/errors';
import { firstSchedule, gradeForCompletion, gradeForVerdict, nextSchedule } from '@/review/memory';
import type { ModulesRepo } from '@/store/modules';
import {
  REVIEW_LOG_INSERT_SQL,
  REVIEW_UPSERT_SQL,
  reviewLogBindings,
  reviewUpsertBindings,
  rowToReviewItem,
  snapshotOf,
  type ReviewRow,
  type ReviewsRepo,
} from '@/store/reviews';

export type CompleteModuleResult = { module: ModuleNode; unlocked: ModuleId[]; review: ReviewItem };
export type CompleteModuleFn = (moduleId: ModuleId, verdict: EvalVerdict) => CompleteModuleResult;

type ModuleRow = {
  id: string;
  topic_id: string;
  title: string;
  ordinal: number;
  kind: string;
  test_out_eligible: number;
  estimated_minutes: number;
  state: string;
  content_json: string | null;
};

function rowToModuleNode(row: ModuleRow): ModuleNode {
  return {
    id: moduleIdSchema.parse(row.id),
    topicId: topicIdSchema.parse(row.topic_id),
    title: row.title,
    ordinal: row.ordinal,
    kind: row.kind as ModuleNode['kind'],
    testOutEligible: row.test_out_eligible === 1,
    estimatedMinutes: row.estimated_minutes,
    state: row.state as ModuleState,
    content: row.content_json ? JSON.parse(row.content_json) : null,
  };
}

function nowIso(): ISODateString {
  return new Date().toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z') as ISODateString;
}

/**
 * The schedule a passing verdict earns, through C7's memory model (F7).
 *
 * WHY C1 calls into C7 here rather than keeping its own copy of the arithmetic: it used to
 * keep a copy, and the copy was the one production actually ran — `completeModule` is the
 * only path a real pass takes. `@/review/memory` is deliberately pure (no store, no clock),
 * so this is a call into C7's algorithm and not into C7's services; there is no cycle.
 *
 * WHY a *review* pass now reads the verdict and a first pass reads only the assist level:
 * a review is a retrieval attempt and can fail, so it grades on the full outcome; a
 * completion is an encoding event that has already succeeded, so it grades on how much help
 * it took and never records a lapse. See `docs/spaced-repetition.md` §3.
 */
function scheduleNext(
  moduleId: ModuleId,
  existing: ReviewItem | null,
  verdict: EvalVerdict,
  now: ISODateString,
): ReviewItem {
  if (existing === null) {
    const scheduled = firstSchedule(gradeForCompletion(verdict.assistLevel), now);
    return {
      moduleId,
      dueAt: scheduled.dueAt,
      intervalDays: scheduled.intervalDays,
      lapses: 0,
      lastAssistLevel: verdict.assistLevel,
      flaggedNeedsReview: verdict.remedialNeeded,
      memory: scheduled.memory,
    };
  }
  const grade = gradeForVerdict(verdict.outcome, verdict.assistLevel);
  const scheduled = nextSchedule(
    {
      memory: existing.memory,
      dueAt: existing.dueAt,
      intervalDays: existing.intervalDays,
      lapses: existing.lapses,
    },
    grade,
    now,
  );
  return {
    moduleId,
    dueAt: scheduled.dueAt,
    intervalDays: scheduled.intervalDays,
    lapses: scheduled.lapsed ? existing.lapses + 1 : existing.lapses,
    lastAssistLevel: verdict.assistLevel,
    flaggedNeedsReview: verdict.remedialNeeded || scheduled.lapsed,
    memory: scheduled.memory,
  };
}

export function createCompleteModule(
  db: Database.Database,
  _modules: ModulesRepo,
  _reviews: ReviewsRepo,
): CompleteModuleFn {
  const getModuleStmt = db.prepare('SELECT * FROM module_nodes WHERE id = ?');
  const updateCompletedModuleStmt = db.prepare(
    'UPDATE module_nodes SET state = ?, last_verdict_json = ?, last_verdict_at = ? WHERE id = ?',
  );
  const updateStateOnlyStmt = db.prepare('UPDATE module_nodes SET state = ? WHERE id = ?');
  const edgesFromStmt = db.prepare('SELECT to_module FROM prereq_edges WHERE topic_id = ? AND from_module = ?');
  const edgesToStmt = db.prepare('SELECT from_module FROM prereq_edges WHERE topic_id = ? AND to_module = ?');
  const getReviewStmt = db.prepare('SELECT * FROM review_items WHERE module_id = ?');
  const upsertReviewStmt = db.prepare(REVIEW_UPSERT_SQL);
  const insertReviewLogStmt = db.prepare(REVIEW_LOG_INSERT_SQL);

  const tx = db.transaction((moduleId: ModuleId, verdict: EvalVerdict): CompleteModuleResult => {
    const moduleRow = getModuleStmt.get(moduleId) as ModuleRow | undefined;
    if (!moduleRow) {
      throw err('not-found', { detail: 'module not found for completion' });
    }
    if (verdict.outcome !== 'pass' && verdict.outcome !== 'assisted-pass') {
      throw err('validation', { detail: 'completeModule requires a passing verdict' });
    }

    const newState: ModuleState = verdict.outcome === 'assisted-pass' ? 'assisted-pass' : 'completed';
    const now = nowIso();
    updateCompletedModuleStmt.run(newState, JSON.stringify(verdict), now, moduleId);

    const unlocked: ModuleId[] = [];
    const candidateRows = edgesFromStmt.all(moduleRow.topic_id, moduleId) as { to_module: string }[];
    for (const { to_module: candidateId } of candidateRows) {
      const candidateRow = getModuleStmt.get(candidateId) as ModuleRow | undefined;
      if (!candidateRow || candidateRow.state !== 'not-yet-recommended') continue;
      const prereqRows = edgesToStmt.all(moduleRow.topic_id, candidateId) as { from_module: string }[];
      const allMet = prereqRows.every(({ from_module: p }) => {
        if (p === moduleId) return true;
        const prereqRow = getModuleStmt.get(p) as ModuleRow | undefined;
        return prereqRow !== undefined && (prereqRow.state === 'completed' || prereqRow.state === 'assisted-pass');
      });
      if (allMet) {
        updateStateOnlyStmt.run('available', candidateId);
        unlocked.push(moduleIdSchema.parse(candidateId));
      }
    }

    const existingReviewRow = getReviewStmt.get(moduleId) as ReviewRow | undefined;
    const existingReview = existingReviewRow ? rowToReviewItem(existingReviewRow) : null;
    const scheduled = scheduleNext(moduleId, existingReview, verdict, now);
    upsertReviewStmt.run(reviewUpsertBindings(scheduled));
    // Same transaction as the upsert above, so the log and the state it describes are
    // written or rolled back together. The grade is the one `scheduleNext` used.
    insertReviewLogStmt.run(
      reviewLogBindings({
        moduleId,
        reviewedAt: now,
        grade:
          existingReview === null
            ? gradeForCompletion(verdict.assistLevel)
            : gradeForVerdict(verdict.outcome, verdict.assistLevel),
        before: existingReview === null ? null : snapshotOf(existingReview),
        after: snapshotOf(scheduled),
      }),
    );

    const finalModuleRow = getModuleStmt.get(moduleId) as ModuleRow;
    return { module: rowToModuleNode(finalModuleRow), unlocked, review: scheduled };
  });

  return (moduleId: ModuleId, verdict: EvalVerdict): CompleteModuleResult => tx(moduleId, verdict);
}
