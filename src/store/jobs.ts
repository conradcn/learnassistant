// FRACTAL: implements F5, F1, F13 | component C1
import type Database from 'better-sqlite3';
import { appErrorSchema, jobSchema, moduleIdSchema, topicIdSchema, type AppErrorShape, type Job, type JobStatus, type TopicId } from '@/shapes';
import { err } from '@/core/errors';

/**
 * A job with the moment it was asked for. WHY `queuedAt` is not on `Job` itself: nothing
 * in the orchestrator ever needed it — the queue is ordered by it inside SQL — and the one
 * caller that does need it is the screen that tells the learner how long they have been
 * waiting.
 */
export type JobRecord = Job & { queuedAt: string };

export type JobsRepo = {
  enqueue(j: Job): Job;
  claimNext(): Job | null;
  finish(id: string, status: JobStatus, error?: AppErrorShape): void;
  requeueRunning(): string[];
  pendingFor(topicId: TopicId): number;
  queuedCount(): number;
  recent(limit: number): JobRecord[];
};

type JobRow = {
  id: string;
  kind: string;
  topic_id: string;
  module_id: string | null;
  status: string;
  attempts: number;
  started_at: string | null;
  finished_at: string | null;
  error_json: string | null;
  queued_at: string;
};

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    kind: row.kind as Job['kind'],
    topicId: topicIdSchema.parse(row.topic_id),
    moduleId: row.module_id ? moduleIdSchema.parse(row.module_id) : null,
    status: row.status as JobStatus,
    attempts: row.attempts,
    startedAt: row.started_at as Job['startedAt'],
    finishedAt: row.finished_at as Job['finishedAt'],
    error: row.error_json ? JSON.parse(row.error_json) : null,
  };
}

function nowIso(): string {
  return new Date().toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');
}

export function createJobsRepo(db: Database.Database): JobsRepo {
  const insertStmt = db.prepare(`
    INSERT INTO jobs (id, kind, topic_id, module_id, status, attempts, started_at, finished_at, error_json, queued_at)
    VALUES (@id, @kind, @topicId, @moduleId, @status, @attempts, @startedAt, @finishedAt, @errorJson, @queuedAt)
  `);
  const claimSelectStmt = db.prepare(
    "SELECT * FROM jobs WHERE status = 'queued' ORDER BY queued_at ASC LIMIT 1",
  );
  const claimUpdateStmt = db.prepare(
    "UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ? WHERE id = ? AND status = 'queued'",
  );
  const getStmt = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const runningStmt = db.prepare("SELECT id FROM jobs WHERE status = 'running'");
  const requeueStmt = db.prepare(
    "UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running'",
  );
  const pendingStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM jobs WHERE topic_id = ? AND status IN ('queued', 'running')",
  );
  const queuedCountStmt = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'");
  const recentStmt = db.prepare('SELECT * FROM jobs ORDER BY queued_at DESC, rowid DESC LIMIT ?');
  const finishStmt = db.prepare('UPDATE jobs SET status = ?, finished_at = ?, error_json = ? WHERE id = ?');

  return {
    enqueue(j: Job): Job {
      const parsed = jobSchema.safeParse(j);
      if (!parsed.success) {
        throw err('validation', { detail: 'job failed shape validation' });
      }
      insertStmt.run({
        id: parsed.data.id,
        kind: parsed.data.kind,
        topicId: parsed.data.topicId,
        moduleId: parsed.data.moduleId,
        status: parsed.data.status,
        attempts: parsed.data.attempts,
        startedAt: parsed.data.startedAt,
        finishedAt: parsed.data.finishedAt,
        errorJson: parsed.data.error ? JSON.stringify(parsed.data.error) : null,
        queuedAt: nowIso(),
      });
      return parsed.data;
    },

    claimNext(): Job | null {
      const claimTx = db.transaction((): JobRow | null => {
        const candidate = claimSelectStmt.get() as JobRow | undefined;
        if (!candidate) return null;
        claimUpdateStmt.run(nowIso(), candidate.id);
        return getStmt.get(candidate.id) as JobRow;
      });
      const row = claimTx();
      return row ? rowToJob(row) : null;
    },

    // WHY: the in-flight index is a file, and a file can be lost, truncated or never
    // written when the process died between claiming a job and recording it. A job left
    // `running` by a dead process is then invisible to `claimNext` (which only ever looks
    // at `queued`) and owned by nobody, so the subject it belongs to sits on "Planning
    // your lessons…" forever. The database is the one place that always knows, so boot
    // recovery asks it rather than the index.
    requeueRunning(): string[] {
      const requeueTx = db.transaction((): string[] => {
        const ids = (runningStmt.all() as { id: string }[]).map((r) => r.id);
        if (ids.length > 0) requeueStmt.run();
        return ids;
      });
      return requeueTx();
    },

    pendingFor(topicId: TopicId): number {
      const row = pendingStmt.get(topicIdSchema.parse(topicId)) as { n: number };
      return row.n;
    },

    // WHY: work waiting for a claim, across every subject. The pump is edge-triggered —
    // it runs because a request enqueued something — so anything that loses that edge
    // leaves rows here with nobody coming back for them. This is how the heartbeat asks
    // the one record that always knows whether the queue is actually draining.
    queuedCount(): number {
      const row = queuedCountStmt.get() as { n: number };
      return row.n;
    },

    // WHY newest first and bounded: this feeds a screen, and a learner who has been using
    // the app for a month has hundreds of finished rows behind the handful they are
    // actually asking about. The caller decides how many of them to show.
    recent(limit: number): JobRecord[] {
      const rows = recentStmt.all(Math.max(0, Math.trunc(limit))) as JobRow[];
      return rows.map((row) => ({ ...rowToJob(row), queuedAt: row.queued_at }));
    },

    finish(id: string, status: JobStatus, error?: AppErrorShape): void {
      if (error !== undefined) {
        const parsed = appErrorSchema.safeParse(error);
        if (!parsed.success) {
          throw err('validation', { detail: 'job error failed shape validation' });
        }
      }
      const result = finishStmt.run(status, nowIso(), error ? JSON.stringify(error) : null, id);
      if (result.changes === 0) {
        throw err('not-found', { detail: 'job not found for finish' });
      }
    },
  };
}
