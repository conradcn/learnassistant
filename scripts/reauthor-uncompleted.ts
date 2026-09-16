/**
 * One-off: re-author the lessons of a topic that the learner has not started yet.
 *
 * WHY it exists: the "Mathematics for Machine Learning" topic was written before
 * buildPrompt told authoring sessions how to use the driving question, and because that
 * topic's driving question IS a formula, every lesson quietly became another reading of
 * the same cross-entropy line — norms, Bayes' rule and the SVD all taught through it.
 * The prompt now says the driving question is the destination and not the running
 * example; this re-runs the same authoring path so the lessons ahead of the learner are
 * written under the fixed prompt.
 *
 * WHY only the unstarted ones: a lesson the learner has already passed is part of what
 * they remember, and rewriting it underneath them would make their own history wrong.
 * `completed` and `assisted-pass` are left exactly as they are.
 *
 * Run: npx vite-node scripts/reauthor-uncompleted.ts -- <topicId> [--dry]
 */
import { openStore } from '@/store/open';
import { SessionRunner } from '@/cli/run-session';
import { authorModule } from '@/orchestrator/author-module';
import { readTopicState } from '@/orchestrator/topic-state';
import type { ModuleId, Topic, TopicId } from '@/shapes';
import path from 'node:path';

const DONE = new Set(['completed', 'assisted-pass']);

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const topicId = args.find((a) => a.startsWith('t_')) as TopicId | undefined;
  const dry = args.includes('--dry');
  const only = args.filter((a) => a.startsWith('m_')) as ModuleId[];
  if (topicId === undefined) throw new Error('usage: reauthor-uncompleted.ts <topicId> [--dry] [moduleId...]');

  const dataRoot = path.resolve('./data');
  const store = openStore(dataRoot);
  const runner = new SessionRunner();
  const deps = { store, runner, dataRoot };

  const loaded = store.topics.get(topicId);
  if (loaded === null) throw new Error(`no such topic: ${topicId}`);
  // WHY the guard: a degraded row carries no subject or purpose, so there is no brief to
  // author from. Re-authoring one would send a session an empty topic and get an empty
  // lesson back, which is worse than the lesson that is already on disk.
  if ('degraded' in loaded && loaded.degraded === true) throw new Error(`topic is degraded: ${topicId}`);
  const topic = loaded as Topic;
  const state = readTopicState(dataRoot, topicId);
  const drivingQuestion = state.drivingQuestion ?? `What does it really take to understand ${topic.subject}?`;

  const graph = store.modules.graph(topicId);
  const targets = graph.nodes.filter(
    (n) =>
      n.kind !== 'capstone' &&
      n.content !== null &&
      !DONE.has(String(n.state)) &&
      (only.length === 0 || only.includes(n.id)),
  );

  console.log(`topic: ${topic.subject}`);
  console.log(`driving question: ${drivingQuestion.slice(0, 120)}...`);
  console.log(`re-authoring ${targets.length} unstarted lesson(s):`);
  for (const n of targets) console.log(`  ${n.id}  ${n.state}  ${n.title}`);
  if (dry) return;

  const controller = new AbortController();
  let ok = 0;
  let failed = 0;
  for (const node of targets) {
    const started = Date.now();
    const outcome = await authorModule(
      deps,
      topic,
      drivingQuestion,
      graph,
      node,
      [`Understand ${node.title}.`],
      controller.signal,
    );
    const secs = Math.round((Date.now() - started) / 1000);
    if (outcome.ok) {
      ok += 1;
      console.log(`ok   ${secs}s  ${node.title}`);
    } else {
      failed += 1;
      console.log(`FAIL ${secs}s  ${node.title} — ${outcome.code}: ${outcome.note.message}`);
    }
  }
  console.log(`done: ${ok} rewritten, ${failed} failed`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
