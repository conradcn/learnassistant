/**
 * One-off: re-write a topic's final-project brief under the current capstone prompt.
 *
 * WHY it exists: capstone briefs were written before the prompt said the tutor proposes
 * the project. Some came back asking the learner to pick their own case and go and find
 * its sources — the Macroeconomics brief opened with "Choose your episode" — which leaves
 * the learner to invent the project. This re-runs the same authoring path so the brief is
 * one the tutor set.
 *
 * WHY it refuses a project that has been handed in: the review conversation is about the
 * brief the learner built against, and swapping the brief underneath it would make their
 * own submissions answer a question they were never asked.
 *
 * Run: npx vite-node --config scripts/vite-node.config.mts scripts/reauthor-capstone.ts -- <topicId> [--dry]
 */
import { openStore } from '@/store/open';
import { SessionRunner } from '@/cli/run-session';
import { authorCapstoneSpec } from '@/orchestrator/capstone-spec';
import { readTopicState } from '@/orchestrator/topic-state';
import { sessionIdFor } from '@/eval/session';
import type { Topic, TopicId } from '@/shapes';
import path from 'node:path';

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const topicId = args.find((a) => a.startsWith('t_')) as TopicId | undefined;
  const dry = args.includes('--dry');
  if (topicId === undefined) throw new Error('usage: reauthor-capstone.ts <topicId> [--dry]');

  const dataRoot = path.resolve('./data');
  const store = openStore(dataRoot);
  const runner = new SessionRunner();
  const deps = { store, runner, dataRoot };

  const loaded = store.topics.get(topicId);
  if (loaded === null) throw new Error(`no such topic: ${topicId}`);
  if ('degraded' in loaded && loaded.degraded === true) throw new Error(`topic is degraded: ${topicId}`);
  const topic = loaded as Topic;
  const state = readTopicState(dataRoot, topicId);
  const drivingQuestion = state.drivingQuestion ?? `What does it really take to understand ${topic.subject}?`;

  const graph = store.modules.graph(topicId);
  const node = graph.nodes.find((n) => n.kind === 'capstone');
  if (node === undefined) throw new Error(`topic has no final project: ${topicId}`);
  if (node.state === 'completed' || node.state === 'assisted-pass' || node.state === 'in-progress') {
    throw new Error(`the final project has already been worked on (${node.state}); leaving its brief alone`);
  }

  const review = store.evals.get(sessionIdFor('capstone', { kind: 'capstone', topicId }));
  if (review !== null && review.turns.some((turn) => turn.role === 'learner')) {
    throw new Error('work has already been handed in against this brief; leaving it alone');
  }

  console.log(`topic: ${topic.subject}`);
  console.log(`re-authoring ${node.id}  ${node.state}  ${node.title}`);
  if (dry) return;

  const started = Date.now();
  const outcome = await authorCapstoneSpec(deps, topic, drivingQuestion, graph, node, new AbortController().signal);
  const secs = Math.round((Date.now() - started) / 1000);
  if (!outcome.ok) throw new Error(`FAIL ${secs}s — ${outcome.note.message}`);
  const content = outcome.node.content;
  console.log(`ok ${secs}s${outcome.usedSynthesisFallback ? ' (synthesis fallback)' : ''}`);
  if (content !== null && content.explanation.kind === 'text') console.log(content.explanation.markdown);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
