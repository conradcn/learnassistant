// FRACTAL: implements F5, F1, F13 | component C1
import type Database from 'better-sqlite3';
import {
  moduleGraphSchema,
  moduleIdSchema,
  moduleNodeSchema,
  topicIdSchema,
  type ModuleGraph,
  type ModuleNode,
  type ModuleId,
  type ModuleState,
  type TopicId,
} from '@/shapes';
import { err } from '@/core/errors';

/**
 * A module without its content blob: everything the store knows about a lesson except
 * the JSON that makes it expensive to read.
 */
export type ModuleSummary = Omit<ModuleNode, 'content'>;

export type ModulesRepo = {
  upsertGraph(g: ModuleGraph): void;
  /**
   * Write one node and nothing else. WHY: `upsertGraph` rewrites every row in the topic
   * from a graph the caller read earlier, so two concurrent module commits — the
   * orchestrator fans them out unbounded — make the later writer restore the stale copy
   * of the node the earlier one just committed. A single-row write cannot lose that update.
   */
  upsertNode(n: ModuleNode): void;
  graph(t: TopicId): ModuleGraph;
  /**
   * The same graph shape as `graph()` with every node's `content` left at null. WHY: the
   * dashboard only reads ids, kinds and states, and `graph()` would JSON.parse every lesson
   * blob in the topic to hand them over. Callers that touch `.content` must use `graph()`.
   */
  summaryGraph(t: TopicId): ModuleGraph;
  /**
   * Every module in the database, blob-free. WHY: callers that only need to place a
   * module — its topic, title and state — must not pay to parse every lesson's content
   * to get there. One query, no JSON.parse.
   */
  index(): ModuleSummary[];
  /** The one full node, content included. The single-lesson counterpart to `index()`. */
  node(id: ModuleId): ModuleNode | null;
  setState(id: ModuleId, s: ModuleState): void;
};

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

function rowToModuleSummary(row: Omit<ModuleRow, 'content_json'>): ModuleSummary {
  return {
    id: moduleIdSchema.parse(row.id),
    topicId: topicIdSchema.parse(row.topic_id),
    title: row.title,
    ordinal: row.ordinal,
    kind: row.kind as ModuleNode['kind'],
    testOutEligible: row.test_out_eligible === 1,
    estimatedMinutes: row.estimated_minutes,
    state: row.state as ModuleState,
  };
}

function rowToModuleNode(row: ModuleRow): ModuleNode {
  return {
    ...rowToModuleSummary(row),
    content: row.content_json ? JSON.parse(row.content_json) : null,
  };
}

export function createModulesRepo(db: Database.Database): ModulesRepo {
  const upsertNodeStmt = db.prepare(`
    INSERT INTO module_nodes (id, topic_id, title, ordinal, kind, test_out_eligible, estimated_minutes, state, content_json)
    VALUES (@id, @topicId, @title, @ordinal, @kind, @testOutEligible, @estimatedMinutes, @state, @contentJson)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      ordinal = excluded.ordinal,
      kind = excluded.kind,
      test_out_eligible = excluded.test_out_eligible,
      estimated_minutes = excluded.estimated_minutes,
      state = excluded.state,
      content_json = excluded.content_json
  `);
  const insertEdgeStmt = db.prepare(
    'INSERT OR IGNORE INTO prereq_edges (topic_id, from_module, to_module) VALUES (?, ?, ?)',
  );
  const deleteEdgesStmt = db.prepare('DELETE FROM prereq_edges WHERE topic_id = ?');
  const insertEntryStmt = db.prepare(
    'INSERT OR IGNORE INTO module_graph_entry (topic_id, module_id) VALUES (?, ?)',
  );
  const deleteEntryStmt = db.prepare('DELETE FROM module_graph_entry WHERE topic_id = ?');
  const nodesStmt = db.prepare('SELECT * FROM module_nodes WHERE topic_id = ? ORDER BY ordinal ASC');
  const edgesStmt = db.prepare('SELECT from_module, to_module FROM prereq_edges WHERE topic_id = ?');
  const entryStmt = db.prepare('SELECT module_id FROM module_graph_entry WHERE topic_id = ?');
  const setStateStmt = db.prepare('UPDATE module_nodes SET state = ? WHERE id = ?');
  const summaryColumns = 'id, topic_id, title, ordinal, kind, test_out_eligible, estimated_minutes, state';
  const indexStmt = db.prepare(`SELECT ${summaryColumns} FROM module_nodes ORDER BY topic_id ASC, ordinal ASC`);
  const summaryNodesStmt = db.prepare(
    `SELECT ${summaryColumns} FROM module_nodes WHERE topic_id = ? ORDER BY ordinal ASC`,
  );
  const nodeStmt = db.prepare('SELECT * FROM module_nodes WHERE id = ?');

  function runUpsertNode(node: ModuleNode): void {
    upsertNodeStmt.run({
      id: node.id,
      topicId: node.topicId,
      title: node.title,
      ordinal: node.ordinal,
      kind: node.kind,
      testOutEligible: node.testOutEligible ? 1 : 0,
      estimatedMinutes: node.estimatedMinutes,
      state: node.state,
      contentJson: node.content ? JSON.stringify(node.content) : null,
    });
  }

  const upsertGraphTx = db.transaction((g: ModuleGraph) => {
    deleteEdgesStmt.run(g.topicId);
    deleteEntryStmt.run(g.topicId);
    for (const node of g.nodes) {
      runUpsertNode(node);
    }
    for (const edge of g.edges) {
      insertEdgeStmt.run(g.topicId, edge.from, edge.to);
    }
    for (const entry of g.entryModules) {
      insertEntryStmt.run(g.topicId, entry);
    }
  });

  function buildGraph(t: TopicId, nodes: ModuleNode[]): ModuleGraph {
    const edges = (edgesStmt.all(t) as { from_module: string; to_module: string }[]).map((e) => ({
      from: moduleIdSchema.parse(e.from_module),
      to: moduleIdSchema.parse(e.to_module),
    }));
    const entryModules = (entryStmt.all(t) as { module_id: string }[]).map((e) =>
      moduleIdSchema.parse(e.module_id),
    );
    return { topicId: t, nodes, edges, entryModules };
  }

  return {
    upsertGraph(g: ModuleGraph): void {
      const parsed = moduleGraphSchema.safeParse(g);
      if (!parsed.success) {
        throw err('validation', { detail: 'module graph failed shape validation' });
      }
      upsertGraphTx(parsed.data);
    },

    upsertNode(n: ModuleNode): void {
      const parsed = moduleNodeSchema.safeParse(n);
      if (!parsed.success) {
        throw err('validation', { detail: 'module node failed shape validation' });
      }
      runUpsertNode(parsed.data);
    },

    graph(t: TopicId): ModuleGraph {
      return buildGraph(t, (nodesStmt.all(t) as ModuleRow[]).map(rowToModuleNode));
    },

    summaryGraph(t: TopicId): ModuleGraph {
      const nodes = (summaryNodesStmt.all(t) as Omit<ModuleRow, 'content_json'>[]).map((row) => ({
        ...rowToModuleSummary(row),
        content: null,
      }));
      return buildGraph(t, nodes);
    },

    index(): ModuleSummary[] {
      return (indexStmt.all() as Omit<ModuleRow, 'content_json'>[]).map(rowToModuleSummary);
    },

    node(id: ModuleId): ModuleNode | null {
      const row = nodeStmt.get(id) as ModuleRow | undefined;
      return row === undefined ? null : rowToModuleNode(row);
    },

    setState(id: ModuleId, s: ModuleState): void {
      const result = setStateStmt.run(s, id);
      if (result.changes === 0) {
        throw err('not-found', { detail: 'module not found for setState' });
      }
    },
  };
}
