// FRACTAL: implements F5, F9, F13 | component C5
import type Database from 'better-sqlite3';
import {
  capstoneRollupStatusSchema,
  topicIdSchema,
  topicStatusSchema,
  type CapstoneRollupStatus,
  type DashboardTopic,
  type DashboardView,
  type ISODateString,
  type TopicStatus,
} from '@/shapes';
import { AppError, err } from '@/core/errors';
import { rollupFromCounts } from '@/graph/rollup';

export {
  dashboardViewSchema,
  type DashboardTopic,
  type DashboardView,
} from '@/shapes';

export type TopicAggregate = {
  id: string;
  subject: string;
  storedStatus: string;
  capstoneStatus: string;
  moduleCount: number;
  completedCount: number;
  availableCount: number;
  needsReviewCount: number;
  assistedPassCount: number;
};

export type DashboardSource = {
  topicAggregates(): TopicAggregate[];
  reviewsDueCount(now: ISODateString): number;
  topicsWithCompletedModulesCount(): number;
};

export const TOPIC_COMPARATOR = (a: DashboardTopic, b: DashboardTopic): number =>
  a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0;

const SYNTHESIS_MIN_TOPICS = 2;

function toStatus(value: string): TopicStatus {
  const parsed = topicStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : 'needs-attention';
}

function toCapstone(value: string): CapstoneRollupStatus {
  const parsed = capstoneRollupStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : 'n/a';
}

function toDashboardTopic(row: TopicAggregate): DashboardTopic {
  const stored = toStatus(row.storedStatus);
  const capstone = toCapstone(row.capstoneStatus);
  return {
    id: topicIdSchema.parse(row.id),
    subject: row.subject,
    status: rollupFromCounts(row.moduleCount, row.completedCount, capstone, stored),
    completedCount: row.completedCount,
    availableCount: row.availableCount,
    remainingCount: Math.max(0, row.moduleCount - row.completedCount - row.availableCount),
    capstone,
    needsReviewCount: row.needsReviewCount,
    assistedPassCount: row.assistedPassCount,
  };
}

function nowIso(): ISODateString {
  return new Date().toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z') as ISODateString;
}

export function dashboard(source: DashboardSource, now: ISODateString = nowIso()): DashboardView {
  try {
    const topics = source.topicAggregates().map(toDashboardTopic);
    topics.sort(TOPIC_COMPARATOR);
    return {
      topics,
      reviewsDue: source.reviewsDueCount(now),
      synthesisAvailable: source.topicsWithCompletedModulesCount() >= SYNTHESIS_MIN_TOPICS,
    };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw err('internal', { detail: 'dashboard read failed', cause: e });
  }
}

const TOPIC_AGGREGATE_SQL = `
  SELECT t.id AS id,
         t.subject AS subject,
         t.status AS stored_status,
         COALESCE(c.status, 'n/a') AS capstone_status,
         SUM(CASE WHEN m.id IS NOT NULL AND m.kind <> 'capstone' THEN 1 ELSE 0 END) AS module_count,
         -- WHY: 'needs-review' is only ever reached by re-flagging a module the learner
         -- already finished (see recordReview), so it still counts as completed here.
         -- Dropping it would erase finished work from progress the moment a review is
         -- missed, and would strip the topic of F9 synthesis eligibility with it.
         SUM(CASE WHEN m.kind <> 'capstone' AND m.state IN ('completed', 'assisted-pass', 'needs-review') THEN 1 ELSE 0 END) AS completed_count,
         SUM(CASE WHEN m.kind <> 'capstone' AND m.state = 'available' THEN 1 ELSE 0 END) AS available_count,
         SUM(CASE WHEN m.kind <> 'capstone' AND m.state = 'needs-review' THEN 1 ELSE 0 END) AS needs_review_count,
         SUM(CASE WHEN m.kind <> 'capstone' AND m.state = 'assisted-pass' THEN 1 ELSE 0 END) AS assisted_pass_count
  FROM topics t
  LEFT JOIN module_nodes m ON m.topic_id = t.id
  LEFT JOIN capstones c ON c.topic_id = t.id
  GROUP BY t.id
`;

type AggregateRow = {
  id: string;
  subject: string;
  stored_status: string;
  capstone_status: string;
  module_count: number;
  completed_count: number;
  available_count: number;
  needs_review_count: number;
  assisted_pass_count: number;
};

export function sqliteDashboardSource(db: Database.Database): DashboardSource {
  const aggregateStmt = db.prepare(TOPIC_AGGREGATE_SQL);
  const reviewsDueStmt = db.prepare('SELECT COUNT(*) AS n FROM review_items WHERE due_at <= ?');
  const completedTopicsStmt = db.prepare(
    // WHY: same rule as completed_count above — a re-flagged module is still finished.
    "SELECT COUNT(DISTINCT topic_id) AS n FROM module_nodes WHERE state IN ('completed', 'assisted-pass', 'needs-review')",
  );

  return {
    topicAggregates(): TopicAggregate[] {
      return (aggregateStmt.all() as AggregateRow[]).map((row) => ({
        id: row.id,
        subject: row.subject,
        storedStatus: row.stored_status,
        capstoneStatus: row.capstone_status,
        moduleCount: row.module_count,
        completedCount: row.completed_count,
        availableCount: row.available_count,
        needsReviewCount: row.needs_review_count,
        assistedPassCount: row.assisted_pass_count,
      }));
    },
    reviewsDueCount(now: ISODateString): number {
      return (reviewsDueStmt.get(now) as { n: number }).n;
    },
    topicsWithCompletedModulesCount(): number {
      return (completedTopicsStmt.get() as { n: number }).n;
    },
  };
}
