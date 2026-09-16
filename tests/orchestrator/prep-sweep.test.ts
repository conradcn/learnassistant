// FRACTAL: covers F2 | type unit
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  exampleModuleContent,
  exampleTopic,
  moduleIdSchema,
  topicIdSchema,
  type Job,
  type ModuleGraph,
  type ModuleNode,
  type ModuleState,
  type Topic,
  type TopicId,
  type TopicStatus,
} from '@/shapes';
import { AppError } from '@/core/errors';
import type { Store } from '@/store/open';
import { sweepUnpreparedAvailable, type PrepSweepDeps } from '@/orchestrator/prep-sweep';
import { DEFAULT_TOPIC_STATE, ensureTopicDir, readTopicState, writeTopicState } from '@/orchestrator/topic-state';
import { MAX_RECOVERY_ATTEMPTS } from '@/orchestrator/prepare-available';

function topicId(seed: string): TopicId {
  return topicIdSchema.parse(`t_${seed.padEnd(16, '0')}`);
}

function id(topic: TopicId, n: number): ModuleNode['id'] {
  return moduleIdSchema.parse(`m_${`${topic.slice(2, 6)}${n}`.padStart(16, '0')}`);
}

function node(topic: TopicId, n: number, state: ModuleState, written: boolean): ModuleNode {
  return {
    id: id(topic, n),
    topicId: topic,
    title: `Lesson ${n}`,
    ordinal: n,
    kind: 'module',
    testOutEligible: false,
    estimatedMinutes: 20,
    state,
    content: written ? exampleModuleContent : null,
  };
}

/** A written first lesson the learner has passed, and an unwritten second behind it. */
function chain(topic: TopicId, firstState: ModuleState, secondWritten = false): ModuleGraph {
  const nodes = [node(topic, 1, firstState, true), node(topic, 2, 'not-yet-recommended', secondWritten)];
  return { topicId: topic, nodes, edges: [{ from: nodes[0].id, to: nodes[1].id }], entryModules: [nodes[0].id] };
}

type Fixture = {
  deps: PrepSweepDeps;
  resumeGeneration: ReturnType<typeof vi.fn>;
};

let dataRoot = '';

function fixture(
  topics: { id: TopicId; graph: ModuleGraph; status: TopicStatus; pending?: number; prepAttempts?: number }[],
): Fixture {
  for (const t of topics) {
    ensureTopicDir(dataRoot, t.id);
    writeTopicState(dataRoot, t.id, {
      ...DEFAULT_TOPIC_STATE,
      status: t.status,
      notes: [],
      prepAttempts: t.prepAttempts ?? 0,
    });
  }
  const byId = new Map(topics.map((t) => [t.id, t]));
  const resumeGeneration = vi.fn((): Job => ({ id: 'j_1' }) as Job);
  const store = {
    topics: { list: () => topics.map((t) => ({ ...exampleTopic, id: t.id }) as Topic) },
    modules: { graph: (t: TopicId) => byId.get(t)!.graph },
    jobs: { pendingFor: (t: TopicId) => byId.get(t)?.pending ?? 0 },
  } as unknown as Store;
  return { deps: { store, dataRoot, orchestrator: { resumeGeneration } }, resumeGeneration };
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), 'prep-sweep-'));
});

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('F2: unlocked-but-unwritten lessons are picked up by a background sweep', () => {
  it('queues a writing pass for a ready subject nobody came back for', () => {
    const t = topicId('aaaa');
    const { deps, resumeGeneration } = fixture([{ id: t, graph: chain(t, 'completed'), status: 'ready' }]);

    expect(sweepUnpreparedAvailable(deps)).toEqual({ considered: 1, queued: 1, recovered: 0 });
    expect(resumeGeneration).toHaveBeenCalledWith(t);
  });

  it('leaves subjects with nothing available-and-unwritten alone', () => {
    const t = topicId('bbbb');
    // Written already, and one whose prerequisite has not been passed.
    const { deps, resumeGeneration } = fixture([{ id: t, graph: chain(t, 'completed', true), status: 'ready' }]);

    expect(sweepUnpreparedAvailable(deps)).toEqual({ considered: 0, queued: 0, recovered: 0 });
    expect(resumeGeneration).not.toHaveBeenCalled();
  });

  it('does not hand more work to a subject that already has a job in the queue', () => {
    const t = topicId('cccc');
    const { deps, resumeGeneration } = fixture([
      { id: t, graph: chain(t, 'completed'), status: 'ready', pending: 1 },
    ]);

    expect(sweepUnpreparedAvailable(deps)).toEqual({ considered: 1, queued: 0, recovered: 0 });
    expect(resumeGeneration).not.toHaveBeenCalled();
  });

  it('skips a subject that is not in a state to take a pass', () => {
    const t = topicId('dddd');
    const { deps, resumeGeneration } = fixture([{ id: t, graph: chain(t, 'completed'), status: 'generating' }]);

    expect(sweepUnpreparedAvailable(deps)).toEqual({ considered: 1, queued: 0, recovered: 0 });
    expect(resumeGeneration).not.toHaveBeenCalled();
  });

  it('comes back for a subject parked in needs-attention, and charges it an attempt', () => {
    const t = topicId('dde0');
    const { deps, resumeGeneration } = fixture([{ id: t, graph: chain(t, 'completed'), status: 'needs-attention' }]);

    expect(sweepUnpreparedAvailable(deps)).toEqual({ considered: 1, queued: 1, recovered: 1 });
    expect(resumeGeneration).toHaveBeenCalledWith(t);
    expect(readTopicState(dataRoot, t).prepAttempts).toBe(1);
  });

  it('stops retrying once the recovery budget is spent, rather than failing forever', () => {
    const t = topicId('dde1');
    const { deps, resumeGeneration } = fixture([
      { id: t, graph: chain(t, 'completed'), status: 'needs-attention', prepAttempts: MAX_RECOVERY_ATTEMPTS },
    ]);

    expect(sweepUnpreparedAvailable(deps)).toEqual({ considered: 1, queued: 0, recovered: 0 });
    expect(resumeGeneration).not.toHaveBeenCalled();
    expect(readTopicState(dataRoot, t).prepAttempts).toBe(MAX_RECOVERY_ATTEMPTS);
  });

  it('never hands a recovery pass to a subject that has no outline, which would re-plan it', () => {
    // WHY this is the one that matters: `generate-topic` is both halves of generation, and
    // C4 runs the research half when the store holds no graph. A background loop that could
    // reach such a subject would research a curriculum over and over. It cannot: there is
    // no available-but-unwritten lesson without a plan naming one.
    const t = topicId('dde3');
    const empty: ModuleGraph = { topicId: t, nodes: [], edges: [], entryModules: [] };
    const { deps, resumeGeneration } = fixture([{ id: t, graph: empty, status: 'needs-attention' }]);

    expect(sweepUnpreparedAvailable(deps)).toEqual({ considered: 0, queued: 0, recovered: 0 });
    expect(resumeGeneration).not.toHaveBeenCalled();
    expect(readTopicState(dataRoot, t).prepAttempts).toBe(0);
  });

  it('does not spend an attempt on a healthy subject', () => {
    const t = topicId('dde2');
    const { deps } = fixture([{ id: t, graph: chain(t, 'completed'), status: 'ready' }]);

    sweepUnpreparedAvailable(deps);
    expect(readTopicState(dataRoot, t).prepAttempts).toBe(0);
  });

  it('a subject that refuses the pass does not stop the sweep reaching the next one', () => {
    const first = topicId('eeee');
    const second = topicId('ffff');
    const { deps, resumeGeneration } = fixture([
      { id: first, graph: chain(first, 'completed'), status: 'ready' },
      { id: second, graph: chain(second, 'completed'), status: 'ready-with-notes' },
    ]);
    resumeGeneration.mockImplementationOnce(() => {
      throw new AppError('conflict', 'the subject cannot take a pass right now', 'c_1');
    });

    expect(sweepUnpreparedAvailable(deps)).toEqual({ considered: 2, queued: 1, recovered: 0 });
    expect(resumeGeneration).toHaveBeenCalledTimes(2);
  });
});
