// FRACTAL: covers F2 | type unit
import { describe, expect, it, vi } from 'vitest';
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
  type TopicStatus,
} from '@/shapes';
import { err } from '@/core/errors';
import { MAX_RECOVERY_ATTEMPTS, prepareAvailable, unpreparedAvailable } from '@/orchestrator/prepare-available';

/** The two fields of C4's sidecar the decision reads. */
function state(status: TopicStatus, prepAttempts = 0): { status: TopicStatus; prepAttempts: number } {
  return { status, prepAttempts };
}

const topicId = topicIdSchema.parse('t_9fQ2xK4mZa71bC0d');
const topic: Topic = { ...exampleTopic, id: topicId };

function id(n: number): ModuleNode['id'] {
  return moduleIdSchema.parse(`m_${String(n).padStart(16, '0')}`);
}

function node(n: number, state: ModuleState, written: boolean): ModuleNode {
  return {
    id: id(n),
    topicId,
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
function chain(firstState: ModuleState, secondWritten = false): ModuleGraph {
  const nodes = [node(1, firstState, true), node(2, 'not-yet-recommended', secondWritten)];
  return { topicId, nodes, edges: [{ from: nodes[0].id, to: nodes[1].id }], entryModules: [nodes[0].id] };
}

function fakes(): { orchestrator: { resumeGeneration: ReturnType<typeof vi.fn> } } {
  const job = { id: 'j_1' } as Job;
  return { orchestrator: { resumeGeneration: vi.fn(() => job) } };
}

describe('F2: a lesson the learner has just unlocked is written without being asked', () => {
  it('counts only unwritten lessons whose prerequisites are met', () => {
    expect(unpreparedAvailable(chain('completed')).map((n) => n.ordinal)).toEqual([2]);
    // The prerequisite has not been passed, so nothing behind it is the learner's to start.
    expect(unpreparedAvailable(chain('available'))).toEqual([]);
    // Already written — there is nothing to prepare.
    expect(unpreparedAvailable(chain('completed', true))).toEqual([]);
  });

  it('leaves the capstone to its own action', () => {
    const graph = chain('completed', true);
    const capstone: ModuleNode = { ...node(3, 'available', false), kind: 'capstone' };
    expect(unpreparedAvailable({ ...graph, nodes: [...graph.nodes, capstone] })).toEqual([]);
  });

  it('queues the same pass the subject page button queues', () => {
    const { orchestrator } = fakes();
    const outcome = prepareAvailable(orchestrator, topic, chain('completed'), state('ready'));
    expect(outcome).toMatchObject({ queued: true, jobId: 'j_1' });
    expect(orchestrator.resumeGeneration).toHaveBeenCalledWith(topicId);
  });

  it('starts nothing when every unlocked lesson is already written', () => {
    const { orchestrator } = fakes();
    expect(prepareAvailable(orchestrator, topic, chain('completed', true), state('ready'))).toEqual({
      queued: false,
      reason: 'nothing-to-prepare',
    });
    expect(orchestrator.resumeGeneration).not.toHaveBeenCalled();
  });

  it.each<TopicStatus>(['generating', 'queued'])(
    'does not pile work onto a subject that is %s',
    (status) => {
      const { orchestrator } = fakes();
      expect(prepareAvailable(orchestrator, topic, chain('completed'), state(status))).toEqual({
        queued: false,
        reason: 'busy',
      });
      expect(orchestrator.resumeGeneration).not.toHaveBeenCalled();
    },
  );

  it('retries a subject left in needs-attention, which is where one bad session parks it', () => {
    const { orchestrator } = fakes();
    expect(prepareAvailable(orchestrator, topic, chain('completed'), state('needs-attention'))).toMatchObject({
      queued: true,
      recovery: true,
    });
    expect(orchestrator.resumeGeneration).toHaveBeenCalledWith(topicId);
  });

  it('gives up on a subject that has spent its recovery attempts without writing anything', () => {
    const { orchestrator } = fakes();
    expect(
      prepareAvailable(orchestrator, topic, chain('completed'), state('needs-attention', MAX_RECOVERY_ATTEMPTS)),
    ).toEqual({ queued: false, reason: 'attempts-exhausted' });
    expect(orchestrator.resumeGeneration).not.toHaveBeenCalled();
  });

  it('does not charge a healthy subject against the recovery budget', () => {
    const { orchestrator } = fakes();
    // Attempts spent long ago must never stop a `ready` subject from being written.
    expect(
      prepareAvailable(orchestrator, topic, chain('completed'), state('ready', MAX_RECOVERY_ATTEMPTS + 5)),
    ).toMatchObject({ queued: true, recovery: false });
  });

  it('is refused quietly when the pass cannot start, so the passing turn still lands', () => {
    const orchestrator = {
      resumeGeneration: (): Job => {
        throw err('cli-missing', { detail: 'no lesson writer' });
      },
    };
    expect(prepareAvailable(orchestrator, topic, chain('completed'), state('ready'))).toEqual({
      queued: false,
      reason: 'refused',
    });
  });
});
