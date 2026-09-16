// FRACTAL: covers F5 | type unit
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { openStore, closeStore } from '@/store/open';
import { paths } from '@/core/paths';
import {
  exampleCalibration,
  exampleEvalSession,
  exampleEvalTurn,
  exampleJob,
  examplePrediction,
  exampleReviewItem,
  topicSchema,
  type ModuleId,
  type SessionId,
} from '@/shapes';

describe('topics repository', () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-topics-'));
  });

  afterEach(() => {
    closeStore(dataRoot);
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('saves a diagnostic transcript onto an existing topic', () => {
    const store = openStore(dataRoot);
    const topic = store.topics.create({ subject: 'Linear algebra', level: 'beginner', purpose: '', diagnostic: null });
    store.topics.setDiagnostic(topic.id, { skipped: false, exchanges: [], priorKnowledge: ['Can multiply matrices'] });

    const read = store.topics.get(topic.id);
    expect(read).toMatchObject({ diagnostic: { priorKnowledge: ['Can multiply matrices'] } });
  });

  it('creates and lists a topic with zero progress', () => {
    const store = openStore(dataRoot);
    const topic = store.topics.create({
      subject: 'Information theory',
      level: 'intermediate',
      purpose: 'read Shannon',
      diagnostic: null,
    });

    expect(topicSchema.safeParse(topic).success).toBe(true);
    expect(topic.status).toBe('queued');

    const graph = store.modules.graph(topic.id);
    expect(graph.nodes).toHaveLength(0);

    const listed = store.topics.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: topic.id, subject: 'Information theory' });

    const fetched = store.topics.get(topic.id);
    expect(fetched).toMatchObject({ id: topic.id });
  });

  it('rejects an empty subject and a duplicate subject+level', () => {
    const store = openStore(dataRoot);
    expect(() =>
      store.topics.create({ subject: '   ', level: 'beginner', purpose: '', diagnostic: null }),
    ).toThrow();

    store.topics.create({ subject: 'Topology', level: 'advanced', purpose: 'p', diagnostic: null });
    expect(() =>
      store.topics.create({ subject: 'Topology', level: 'advanced', purpose: 'p2', diagnostic: null }),
    ).toThrow();
  });

  it('persists across a close and reopen of the store', () => {
    const first = openStore(dataRoot);
    const topic = first.topics.create({
      subject: 'Category theory',
      level: 'advanced',
      purpose: 'build compilers',
      diagnostic: null,
    });
    closeStore(dataRoot);

    const second = openStore(dataRoot);
    const fetched = second.topics.get(topic.id);
    expect(fetched).toMatchObject({ id: topic.id, subject: 'Category theory' });
  });

  // WHY this is here and not folded into the bare delete test above: the bare topic has no
  // modules, so it never touched the six tables that are keyed on a module id rather than a
  // topic id. A subject's Socratic transcripts, review schedule, predictions and jobs used to
  // outlive the subject entirely, keyed on ids that referenced nothing.
  it('deletes every trace of a subject: modules, reviews, evals, predictions and jobs', () => {
    const store = openStore(dataRoot);
    const topic = store.topics.create({
      subject: 'Thermodynamics',
      level: 'intermediate',
      purpose: 'p',
      diagnostic: null,
    });
    const other = store.topics.create({
      subject: 'Thermodynamics',
      level: 'beginner',
      purpose: 'p',
      diagnostic: null,
    });

    const m1 = 'm_0000000000000101' as ModuleId;
    const m2 = 'm_0000000000000102' as ModuleId;
    const kept = 'm_0000000000000201' as ModuleId;
    const node = (id: ModuleId, topicId: typeof topic.id, ordinal: number) => ({
      id,
      topicId,
      title: `L${ordinal}`,
      ordinal,
      kind: 'module' as const,
      testOutEligible: false,
      estimatedMinutes: 20,
      state: 'available' as const,
      content: null,
    });
    store.modules.upsertGraph({
      topicId: topic.id,
      nodes: [node(m1, topic.id, 1), node(m2, topic.id, 2)],
      edges: [{ from: m1, to: m2 }],
      entryModules: [m1],
    });
    store.modules.upsertGraph({
      topicId: other.id,
      nodes: [node(kept, other.id, 1)],
      edges: [],
      entryModules: [kept],
    });

    store.reviews.upsert({ ...exampleReviewItem, moduleId: m1 });
    store.reviews.upsert({ ...exampleReviewItem, moduleId: m2 });
    store.reviews.upsert({ ...exampleReviewItem, moduleId: kept });

    const sessionId = 's_0000000000000001' as SessionId;
    store.evals.create({
      ...exampleEvalSession,
      id: sessionId,
      moduleId: m1,
      turns: [
        { ...exampleEvalTurn, id: 'e1' },
        { ...exampleEvalTurn, id: 'e2' },
        { ...exampleEvalTurn, id: 'e3' },
      ],
    });
    const keptSessionId = 's_0000000000000002' as SessionId;
    store.evals.create({
      ...exampleEvalSession,
      id: keptSessionId,
      moduleId: kept,
      turns: [{ ...exampleEvalTurn, id: 'k1' }],
    });

    store.predictions.upsert({ ...examplePrediction, moduleId: m1 });
    store.predictions.upsert({ ...examplePrediction, moduleId: kept });
    store.calibration.upsert({ ...exampleCalibration, moduleId: m1 });
    store.calibration.upsert({ ...exampleCalibration, moduleId: kept });

    store.jobs.enqueue({ ...exampleJob, id: 'j_del', topicId: topic.id, moduleId: m1, status: 'queued' });
    store.jobs.enqueue({ ...exampleJob, id: 'j_keep', topicId: other.id, moduleId: kept, status: 'queued' });

    store.topics.delete(topic.id);
    closeStore(dataRoot);

    const db = new Database(paths(dataRoot).dbFile, { readonly: true });
    try {
      const count = (sql: string, ...args: unknown[]) =>
        (db.prepare(sql).get(...args) as { n: number }).n;

      expect(count('SELECT COUNT(*) AS n FROM topics WHERE id = ?', topic.id)).toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM module_nodes WHERE topic_id = ?', topic.id)).toBe(0);
      expect(
        count('SELECT COUNT(*) AS n FROM review_items WHERE module_id IN (?, ?)', m1, m2),
      ).toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM eval_sessions WHERE module_id IN (?, ?)', m1, m2)).toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM eval_turns WHERE session_id = ?', sessionId)).toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM predictions WHERE module_id IN (?, ?)', m1, m2)).toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM calibration WHERE module_id IN (?, ?)', m1, m2)).toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM jobs WHERE topic_id = ?', topic.id)).toBe(0);

      // The other subject is untouched: the deletes resolve through this topic's modules,
      // not through every module in the store.
      expect(count('SELECT COUNT(*) AS n FROM module_nodes WHERE topic_id = ?', other.id)).toBe(1);
      expect(count('SELECT COUNT(*) AS n FROM review_items WHERE module_id = ?', kept)).toBe(1);
      expect(count('SELECT COUNT(*) AS n FROM eval_sessions WHERE module_id = ?', kept)).toBe(1);
      expect(count('SELECT COUNT(*) AS n FROM eval_turns WHERE session_id = ?', keptSessionId)).toBe(1);
      expect(count('SELECT COUNT(*) AS n FROM predictions WHERE module_id = ?', kept)).toBe(1);
      expect(count('SELECT COUNT(*) AS n FROM calibration WHERE module_id = ?', kept)).toBe(1);
      expect(count('SELECT COUNT(*) AS n FROM jobs WHERE topic_id = ?', other.id)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('deletes a topic', () => {
    const store = openStore(dataRoot);
    const topic = store.topics.create({ subject: 'Optics', level: 'beginner', purpose: 'p', diagnostic: null });
    store.topics.delete(topic.id);
    expect(store.topics.get(topic.id)).toBeNull();
    expect(store.topics.list()).toHaveLength(0);
  });
  it('refuses a duplicate subject-and-level, and creates it once the learner says yes', () => {
    // WHY this exists: the intake screen asked "already learning this — add it again?"
    // and sent the answer, but the server never read it. Saying yes hit the same refusal,
    // so a subject could not be repeated at all — a dead end with a button in it.
    const store = openStore(dataRoot);
    const first = {
      subject: 'Category theory',
      level: 'intermediate' as const,
      purpose: 'read the papers',
      diagnostic: null,
    };
    const original = store.topics.create(first);

    expect(() => store.topics.create(first)).toThrowError(/already exists/);

    const again = store.topics.create({ ...first, allowDuplicate: true });
    expect(again.id).not.toBe(original.id);
    expect(
      store.topics.list().filter((t) => !('degraded' in t) && t.subject === 'Category theory'),
    ).toHaveLength(2);

    // A different level was never a duplicate, and still is not.
    const other = store.topics.create({ ...first, level: 'beginner' });
    expect(other.level).toBe('beginner');
  });
});
