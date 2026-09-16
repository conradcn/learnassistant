// FRACTAL: covers F5 | type integration
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isoDateStringSchema, moduleIdSchema, type ISODateString, type ModuleGraph, type ModuleId, type ModuleNode, type TopicId } from '@/shapes';
import { paths } from '@/core/paths';
import { AppError } from '@/core/errors';
import { closeStore, openStore } from '@/store/open';
import {
  dashboard,
  dashboardViewSchema,
  sqliteDashboardSource,
  type DashboardSource,
  type DashboardView,
} from '@/graph/dashboard';

const GRADE_WORDS = /\b(grade|score|percent|percentage|marks?|points?|gpa|[ABCDF][+-])\b/i;

function mid(topic: number, n: number): ModuleId {
  return moduleIdSchema.parse(`m_${String(topic).padStart(8, '0')}${String(n).padStart(8, '0')}`);
}

function moduleNode(topicId: TopicId, topic: number, n: number, state: ModuleNode['state'], kind: ModuleNode['kind'] = 'module'): ModuleNode {
  return {
    id: mid(topic, n),
    topicId,
    title: `Module ${n}`,
    ordinal: n,
    kind,
    testOutEligible: false,
    estimatedMinutes: 20,
    state,
    content: null,
  };
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(k);
      collectStrings(v, out);
    }
  }
}

describe('dashboard carries no grade of any kind', () => {
  let dataRoot: string;
  let db: Database.Database;
  let view: DashboardView;
  const now: ISODateString = isoDateStringSchema.parse('2030-01-01T00:00:00.000Z');

  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-graph-'));
    const store = openStore(dataRoot);

    const mixed = store.topics.create({ subject: 'Information theory', level: 'intermediate', purpose: 'p', diagnostic: null });
    const empty = store.topics.create({ subject: 'Abstract algebra', level: 'beginner', purpose: 'p', diagnostic: null });

    const mixedGraph: ModuleGraph = {
      topicId: mixed.id,
      nodes: [
        moduleNode(mixed.id, 1, 1, 'completed'),
        moduleNode(mixed.id, 1, 2, 'assisted-pass'),
        moduleNode(mixed.id, 1, 3, 'available'),
        moduleNode(mixed.id, 1, 4, 'not-yet-recommended'),
        moduleNode(mixed.id, 1, 5, 'needs-review'),
        moduleNode(mixed.id, 1, 6, 'available', 'capstone'),
      ],
      edges: [{ from: mid(1, 3), to: mid(1, 4) }],
      entryModules: [mid(1, 1)],
    };
    store.modules.upsertGraph(mixedGraph);
    store.modules.upsertGraph({ topicId: empty.id, nodes: [], edges: [], entryModules: [] });
    store.reviews.upsert({
      moduleId: mid(1, 1),
      dueAt: isoDateStringSchema.parse('2026-01-01T00:00:00.000Z'),
      intervalDays: 3,
      memory: { stability: 3, difficulty: 2.1181, reps: 1, lastReviewedAt: null },
      lapses: 0,
      lastAssistLevel: 0,
      flaggedNeedsReview: false,
    });

    db = new Database(paths(dataRoot).dbFile, { readonly: true });
    view = dashboard(sqliteDashboardSource(db), now);
  });

  afterEach(() => {
    db.close();
    closeStore(dataRoot);
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('produces a DashboardView that validates against its shape', () => {
    expect(dashboardViewSchema.safeParse(view).success).toBe(true);
    expect(view.topics).toHaveLength(2);
  });

  it('expresses progress only as counts of open and completed work', () => {
    const mixed = view.topics.find((t) => t.subject === 'Information theory');
    expect(mixed).toBeDefined();
    // A module only reaches `needs-review` after it was completed, so it counts as
    // finished work here — it is a lesson to revisit, not a lesson still to do.
    expect(mixed?.completedCount).toBe(3);
    expect(mixed?.availableCount).toBe(1);
    expect(mixed?.remainingCount).toBe(1);
    expect(mixed?.assistedPassCount).toBe(1);
    expect(mixed?.needsReviewCount).toBe(1);
  });

  it('shows a topic with zero progress as all remaining and nothing completed', () => {
    const zero = view.topics.find((t) => t.subject === 'Abstract algebra');
    expect(zero?.completedCount).toBe(0);
    expect(zero?.availableCount).toBe(0);
    expect(zero?.remainingCount).toBe(0);
  });

  it('never emits a numeric percentage, letter grade, or score-like key', () => {
    const strings: string[] = [];
    collectStrings(view, strings);
    expect(strings.length).toBeGreaterThan(0);
    for (const s of strings) {
      expect(s).not.toMatch(GRADE_WORDS);
      expect(s).not.toContain('%');
      expect(s).not.toMatch(/\d+\s*\/\s*\d+/);
    }
  });

  it('counts reviews due and withholds synthesis until two topics have completed work', () => {
    expect(view.reviewsDue).toBe(1);
    expect(view.synthesisAvailable).toBe(false);
  });

  it('surfaces a read failure as an AppError instead of an empty dashboard', () => {
    const broken: DashboardSource = {
      topicAggregates() {
        throw new Error('disk went away at /var/lib/learn.db');
      },
      reviewsDueCount() {
        return 0;
      },
      topicsWithCompletedModulesCount() {
        return 0;
      },
    };
    try {
      dashboard(broken, now);
      expect.unreachable('dashboard should surface the read failure');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('internal');
      expect((e as AppError).message).not.toContain('/var/lib');
    }
  });

  it('reports modules-complete and then done from the same aggregates', () => {
    const finished = (capstone: 'in-review' | 'passed'): DashboardView =>
      dashboard(
        {
          topicAggregates: () => [
            {
              id: view.topics[0].id,
              subject: 'Finished topic',
              storedStatus: 'ready',
              capstoneStatus: capstone,
              moduleCount: 4,
              completedCount: 4,
              availableCount: 0,
              needsReviewCount: 0,
              assistedPassCount: 0,
            },
          ],
          reviewsDueCount: () => 0,
          topicsWithCompletedModulesCount: () => 2,
        },
        now,
      );
    expect(finished('in-review').topics[0].status).toBe('modules-complete');
    expect(finished('passed').topics[0].status).toBe('done');
    expect(finished('passed').synthesisAvailable).toBe(true);
  });
});
