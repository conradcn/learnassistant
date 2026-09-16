// FRACTAL: covers F5, F13 | type integration
/**
 * WHY (H10): the dashboard card and the project page each derived "how far along is the
 * final project?" by their own rule. The dashboard read it off the capstone node's state
 * alone, so an available capstone that had never been handed in reported "being looked
 * over" on the home screen while the project page — asking the canonical rule — showed the
 * untouched not-started state. Two screens, two answers, one project. This pins them to the
 * same rule at both ends of the journey, which is where the divergence was visible.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exampleEvalVerdict } from '@/shapes';
import { storeDashboardSource } from '@/api/dashboard-source';
import { capstoneNode, capstoneRounds, capstoneStatus } from '@/eval/capstone';
import { sessionIdFor } from '@/eval/session';
import { evalTargetSchema } from '@/shapes';
import { bootHarness, evaluatorOutput, seedTopic, type Harness } from '@/eval/harness.testing';

let h: Harness;
beforeEach(() => { h = bootHarness(); });
afterEach(async () => { await h.teardown(); });

function canonicalStatus(topicId: ReturnType<typeof seedTopic>['topic']['id']): string {
  const graph = h.store.modules.graph(topicId);
  const node = capstoneNode(graph);
  if (node === null) return 'n/a';
  const session = h.store.evals.get(
    sessionIdFor('capstone', evalTargetSchema.parse({ kind: 'capstone', topicId })),
  );
  return capstoneStatus(node, session === null ? [] : capstoneRounds(session));
}

function dashboardStatus(topicId: string): string {
  const row = storeDashboardSource(h.store).topicAggregates().find((t) => t.id === topicId);
  if (row === undefined) throw new Error('topic missing from the dashboard');
  return row.capstoneStatus;
}

describe('the dashboard and the project page agree about the final project', () => {
  it('does not call a project "in review" before anything has been handed in', () => {
    const { topic, nodes } = seedTopic(h.store, { withCapstone: true });
    for (const m of nodes.filter((n) => n.kind !== 'capstone')) {
      h.store.completeModule(m.id, { ...exampleEvalVerdict, outcome: 'pass', assistLevel: 0 });
    }
    // The capstone node is now open — which is exactly the state the old rule mistook for
    // "being looked over".
    expect(dashboardStatus(topic.id)).toBe('not-started');
    expect(dashboardStatus(topic.id)).toBe(canonicalStatus(topic.id));
  });

  it('agrees once work has actually been handed in, and again once it passes', async () => {
    const { topic, nodes } = seedTopic(h.store, { withCapstone: true });
    for (const m of nodes.filter((n) => n.kind !== 'capstone')) {
      h.store.completeModule(m.id, { ...exampleEvalVerdict, outcome: 'pass', assistLevel: 0 });
    }

    h.respondWith(() => evaluatorOutput({ reply: 'Needs more on the trade-off.', mode: 'question' }));
    await h.engine.submitCapstone(
      topic.id,
      'A Huffman coder in 120 lines, plus notes on why I chose a priority queue.',
    );
    expect(dashboardStatus(topic.id)).toBe('in-review');
    expect(dashboardStatus(topic.id)).toBe(canonicalStatus(topic.id));

    h.respondWith(() =>
      evaluatorOutput({ reply: 'The work stands up.', mode: 'verdict', outcome: 'pass' }),
    );
    await h.engine.submitCapstone(
      topic.id,
      'Revised: I now measure compression ratio against a fixed corpus.',
    );
    expect(dashboardStatus(topic.id)).toBe('passed');
    expect(dashboardStatus(topic.id)).toBe(canonicalStatus(topic.id));
  });
});
