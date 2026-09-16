// One-off repair: register a pass the criteria gate swallowed.
//
// On 2026-08-28 the evaluator returned `pass` on turn 10 of session
// s_kPuoueGECRtimsRA ("Reading Math Notation Like a Type Signature"). The reply it
// wrote is unambiguous — "You've got the line", the whole shape chain, both collapse
// points, the gradient read as a rate — but enforcePassCriteria downgraded it to
// `continue` and logged eval-pass-unsupported-by-criteria (correlationId c_3e7aa02a),
// because the word-overlap check ran over LaTeX-laden criteria whose macro tokens
// ("mathcal", "mathbb", "nabla") can never appear in a prose rationale. That gate is
// fixed in src/eval/verdict-parse.ts; this script repairs the record it already ate.
//
// It mirrors createCompleteModule (src/store/complete.ts) rather than importing it,
// because that module is TypeScript and this repo has no TS runner. Any change to the
// completion rules should be made there; this file is a historical fixup, not a path.
//
// Usage: node scripts/repair-swallowed-pass.mjs [--apply]
import Database from 'better-sqlite3';
import { copyFileSync, existsSync } from 'node:fs';

const DB = 'data/learn.db';
const SESSION_ID = 's_kPuoueGECRtimsRA';
const MODULE_ID = 'm_WKu1XUdOBe0o6yQb';
const TURN_ORDINAL = 10;
const APPLY = process.argv.includes('--apply');

const VERDICT = {
  outcome: 'pass',
  assistLevel: 1,
  misunderstanding: null,
  nextAngle: null,
  remedialNeeded: false,
  rationale:
    'Named every symbol with its type, stated the shape chain unprompted, identified both ' +
    'collapse points, placed W and the weights of h inside theta while excluding x, y and p, ' +
    'and read a gradient entry as a local rate of change — predicting the loss movement for ' +
    'two nudge sizes with the curvature caveat attached. Refused both the multiplication ' +
    'reading of L(theta) and the "approximately equal" reading of x ~ p when nudged toward ' +
    'them. Recorded by scripts/repair-swallowed-pass.mjs: the evaluator returned this pass ' +
    'on 2026-08-28 and the pass-criteria word-overlap gate discarded it.',
};

function nowIso() {
  return new Date().toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');
}

if (!existsSync(DB)) throw new Error(`no database at ${DB}`);
if (APPLY) {
  const backup = `${DB}.pre-pass-repair`;
  copyFileSync(DB, backup);
  console.log(`backed up to ${backup}`);
}

const db = new Database(DB);
db.pragma('foreign_keys = ON');

const turnRow = db
  .prepare('SELECT rowid, turn_json FROM eval_turns WHERE session_id = ? AND ordinal = ?')
  .get(SESSION_ID, TURN_ORDINAL);
if (!turnRow) throw new Error('target turn not found');

const turn = JSON.parse(turnRow.turn_json);
if (turn.role !== 'evaluator') throw new Error('target turn is not an evaluator turn');
if (turn.id !== `v${TURN_ORDINAL}:continue` && turn.id !== `v${TURN_ORDINAL}:pass`) {
  throw new Error(`unexpected turn id ${turn.id}`);
}

const moduleRow = db.prepare('SELECT * FROM module_nodes WHERE id = ?').get(MODULE_ID);
if (!moduleRow) throw new Error('module not found');

console.log(`turn ${turn.id} -> v${TURN_ORDINAL}:pass`);
console.log(`module "${moduleRow.title}" ${moduleRow.state} -> completed`);

const run = db.transaction(() => {
  // The session's status is derived from turn ids (src/eval/turn-id.ts), so the id and
  // mode ARE the durable record of the verdict. Nothing else on the turn is touched —
  // the tutor's text stays exactly as it was written.
  db.prepare('UPDATE eval_turns SET turn_json = ? WHERE rowid = ?').run(
    JSON.stringify({ ...turn, id: `v${TURN_ORDINAL}:pass`, mode: 'verdict' }),
    turnRow.rowid,
  );

  const now = nowIso();
  db.prepare('UPDATE module_nodes SET state = ?, last_verdict_json = ?, last_verdict_at = ? WHERE id = ?').run(
    'completed',
    JSON.stringify(VERDICT),
    now,
    MODULE_ID,
  );

  // Unlock every successor whose prerequisites are now all met.
  const unlocked = [];
  const successors = db
    .prepare('SELECT to_module FROM prereq_edges WHERE topic_id = ? AND from_module = ?')
    .all(moduleRow.topic_id, MODULE_ID);
  for (const { to_module: candidateId } of successors) {
    const candidate = db.prepare('SELECT * FROM module_nodes WHERE id = ?').get(candidateId);
    if (!candidate || candidate.state !== 'not-yet-recommended') continue;
    const prereqs = db
      .prepare('SELECT from_module FROM prereq_edges WHERE topic_id = ? AND to_module = ?')
      .all(moduleRow.topic_id, candidateId);
    const allMet = prereqs.every(({ from_module: p }) => {
      if (p === MODULE_ID) return true;
      const row = db.prepare('SELECT state FROM module_nodes WHERE id = ?').get(p);
      return row !== undefined && (row.state === 'completed' || row.state === 'assisted-pass');
    });
    if (!allMet) continue;
    db.prepare('UPDATE module_nodes SET state = ? WHERE id = ?').run('available', candidateId);
    unlocked.push(candidateId);
  }

  // First review of a clean pass (assistLevel < 2) is three days out — scheduleNext().
  const existing = db.prepare('SELECT * FROM review_items WHERE module_id = ?').get(MODULE_ID);
  const intervalDays = existing ? Math.max(1, Math.round(existing.interval_days * existing.ease)) : 3;
  const dueAt = new Date(Date.parse(now) + intervalDays * 86400000)
    .toISOString()
    .replace(/(\.\d{3})\d*Z$/, '$1Z');
  db.prepare(
    `INSERT INTO review_items (module_id, due_at, interval_days, ease, lapses, last_assist_level, flagged_needs_review)
     VALUES (@moduleId, @dueAt, @intervalDays, @ease, @lapses, @lastAssistLevel, @flaggedNeedsReview)
     ON CONFLICT(module_id) DO UPDATE SET
       due_at = excluded.due_at,
       interval_days = excluded.interval_days,
       ease = excluded.ease,
       lapses = excluded.lapses,
       last_assist_level = excluded.last_assist_level,
       flagged_needs_review = excluded.flagged_needs_review`,
  ).run({
    moduleId: MODULE_ID,
    dueAt,
    intervalDays,
    ease: existing?.ease ?? 2.5,
    lapses: existing?.lapses ?? 0,
    lastAssistLevel: VERDICT.assistLevel,
    flaggedNeedsReview: 0,
  });

  return { unlocked, dueAt, intervalDays };
});

if (!APPLY) {
  console.log('\ndry run — pass --apply to write');
  process.exit(0);
}

const result = run();
console.log(`review due ${result.dueAt} (in ${result.intervalDays} days)`);
console.log(
  result.unlocked.length === 0
    ? 'nothing new unlocked'
    : `unlocked: ${result.unlocked
        .map((id) => db.prepare('SELECT title FROM module_nodes WHERE id = ?').get(id).title)
        .join(', ')}`,
);
db.close();
