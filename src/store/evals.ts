// FRACTAL: implements F5, F1, F13 | component C1
import type Database from 'better-sqlite3';
import {
  evalTurnSchema,
  moduleIdSchema,
  sessionIdSchema,
  type EvalSession,
  type EvalTurn,
  type ModuleId,
  type SessionId,
} from '@/shapes';
import { err } from '@/core/errors';

export type EvalsRepo = {
  create(session: EvalSession): EvalSession;
  append(sessionId: SessionId, turn: EvalTurn): void;
  get(id: SessionId): EvalSession | null;
  listByModule(moduleId: ModuleId): EvalSession[];
  reset(sessionId: SessionId, opening: EvalTurn, openedAt: string): void;
};

type SessionRow = {
  id: string;
  module_id: string;
  kind: string;
  consecutive_failures: number;
  status: string;
  opened_at: string;
};

export function createEvalsRepo(db: Database.Database): EvalsRepo {
  const insertSessionStmt = db.prepare(`
    INSERT INTO eval_sessions (id, module_id, kind, consecutive_failures, status, opened_at)
    VALUES (@id, @moduleId, @kind, @consecutiveFailures, @status, @openedAt)
  `);
  const insertTurnStmt = db.prepare(`
    INSERT INTO eval_turns (session_id, ordinal, turn_json) VALUES (?, ?, ?)
  `);
  const maxOrdinalStmt = db.prepare(
    'SELECT COALESCE(MAX(ordinal), -1) AS maxOrdinal FROM eval_turns WHERE session_id = ?',
  );
  const getSessionStmt = db.prepare('SELECT * FROM eval_sessions WHERE id = ?');
  const byModuleStmt = db.prepare('SELECT * FROM eval_sessions WHERE module_id = ? ORDER BY opened_at ASC');
  const getTurnsStmt = db.prepare('SELECT turn_json FROM eval_turns WHERE session_id = ? ORDER BY ordinal ASC');
  const sessionExistsStmt = db.prepare('SELECT 1 FROM eval_sessions WHERE id = ?');
  const clearTurnsStmt = db.prepare('DELETE FROM eval_turns WHERE session_id = ?');
  const reopenStmt = db.prepare(
    "UPDATE eval_sessions SET consecutive_failures = 0, status = 'open', opened_at = ? WHERE id = ?",
  );

  function buildSession(row: SessionRow): EvalSession {
    const turnRows = getTurnsStmt.all(row.id) as { turn_json: string }[];
    return {
      id: sessionIdSchema.parse(row.id),
      moduleId: moduleIdSchema.parse(row.module_id),
      kind: row.kind as EvalSession['kind'],
      turns: turnRows.map((t) => JSON.parse(t.turn_json)),
      consecutiveFailures: row.consecutive_failures,
      status: row.status as EvalSession['status'],
      openedAt: row.opened_at as EvalSession['openedAt'],
    };
  }

  return {
    create(session: EvalSession): EvalSession {
      insertSessionStmt.run({
        id: session.id,
        moduleId: session.moduleId,
        kind: session.kind,
        consecutiveFailures: session.consecutiveFailures,
        status: session.status,
        openedAt: session.openedAt,
      });
      const appendTx = db.transaction((turns: EvalTurn[]) => {
        turns.forEach((turn, ordinal) => {
          insertTurnStmt.run(session.id, ordinal, JSON.stringify(evalTurnSchema.parse(turn)));
        });
      });
      appendTx(session.turns);
      return session;
    },

    append(sessionId: SessionId, turn: EvalTurn): void {
      if (!sessionExistsStmt.get(sessionId)) {
        throw err('not-found', { detail: 'eval session not found for append' });
      }
      const parsed = evalTurnSchema.safeParse(turn);
      if (!parsed.success) {
        throw err('validation', { detail: 'eval turn failed shape validation' });
      }
      const row = maxOrdinalStmt.get(sessionId) as { maxOrdinal: number };
      insertTurnStmt.run(sessionId, row.maxOrdinal + 1, JSON.stringify(parsed.data));
    },

    // WHY: the session id is derived from the target, so "start this one over" cannot
    // mean a new row — it means this row's transcript is emptied back to its opening
    // question. That is the only thing that ever discards a conversation; every other
    // path resumes it.
    reset(sessionId: SessionId, opening: EvalTurn, openedAt: string): void {
      if (!sessionExistsStmt.get(sessionId)) {
        throw err('not-found', { detail: 'eval session not found for reset' });
      }
      const turn = evalTurnSchema.safeParse(opening);
      if (!turn.success) {
        throw err('validation', { detail: 'opening turn failed shape validation' });
      }
      const resetTx = db.transaction(() => {
        clearTurnsStmt.run(sessionId);
        reopenStmt.run(openedAt, sessionId);
        insertTurnStmt.run(sessionId, 0, JSON.stringify(turn.data));
      });
      resetTx();
    },

    // WHY (F4): a module can be gated by more than one conversation — a `module`
    // session and a `test-out` session share one node — and nothing could see the
    // pair, so an untouched one sat open forever beside the one being used.
    listByModule(moduleId: ModuleId): EvalSession[] {
      return (byModuleStmt.all(moduleId) as SessionRow[]).map(buildSession);
    },

    get(id: SessionId): EvalSession | null {
      const row = getSessionStmt.get(id) as SessionRow | undefined;
      if (!row) return null;
      return buildSession(row);
    },
  };
}
