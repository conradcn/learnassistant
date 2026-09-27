// FRACTAL: implements F2 | component C4
import type { ModuleGraph, ModuleId, ModuleNode, Topic } from '@/shapes';
import { longestProseRun } from '@/ui/blocks';
import { log } from '@/core/log';
import { authorModule } from '@/orchestrator/author-module';
import type { OrchestratorDeps } from '@/orchestrator/session';
import { REPAIR_TARGETS_PER_ROUND } from '@/orchestrator/repair.budget';

/**
 * WHY this file exists at all: the consistency check used to end by writing what it found
 * onto the subject page. A learner who has just asked for a course cannot act on "lesson 9
 * derives a bound whose Jensen step lesson 6 never states" — it is a defect in work the app
 * did, described in the app's own vocabulary, filed against the reader. The findings are a
 * work list for the writer, so this takes them back to the writer: the lessons the check
 * names are rewritten with the finding attached, and the check runs again on the result.
 * What the learner sees is a course that hangs together, not an account of how it did not.
 */

export { MAX_REPAIR_ROUNDS, REPAIR_TARGETS_PER_ROUND } from '@/orchestrator/repair.budget';

export type Finding = { message: string; affectedModules: ModuleId[] };

const ORDINAL_RE = /\b(?:lesson|module)\s+(\d{1,2})\b/gi;

/**
 * WHY a matcher rather than trusting `affectedModules`: the reviewer is asked for ids and
 * mostly answers in prose — on the real run every one of seventeen findings came back with
 * an empty id list and named its lessons as "lesson 6" and "'Probability Foundations'"
 * instead. A finding nobody can route is a finding nobody can fix, so the ordinals and
 * titles in the text are read as the addresses they plainly are. Ids the reviewer did give
 * are still preferred, and both are checked against this topic's own graph.
 */
export function repairTargets(graph: ModuleGraph, finding: Finding): ModuleId[] {
  const known = new Map(graph.nodes.map((n) => [n.id, n]));
  const named = finding.affectedModules.filter((id) => known.has(id));
  if (named.length > 0) return [...new Set(named)];

  const hits = new Set<ModuleId>();
  const haystack = finding.message.toLowerCase();
  for (const match of finding.message.matchAll(ORDINAL_RE)) {
    const ordinal = Number(match[1]);
    const node = graph.nodes.find((n) => n.ordinal === ordinal);
    if (node !== undefined) hits.add(node.id);
  }
  for (const node of graph.nodes) {
    // WHY a length floor: a one-word title such as "Notation" matches half the prose in
    // the topic, and a finding routed to every lesson is routed to none of them.
    if (node.title.length >= 12 && haystack.includes(node.title.toLowerCase())) hits.add(node.id);
  }
  return graph.nodes.filter((n) => hits.has(n.id)).map((n) => n.id);
}

/**
 * The interleaving contract, as the writing prompt states it: never more than two "prose"
 * blocks in a row without a figure, table, plot, interactive, check or reveal between them.
 */
export const MAX_PROSE_RUN = 2;

/**
 * WHY a finding rather than a schema refusal or a note on the page: a lesson that came back
 * as a wall of text — or with no body at all, which a quantised local model does return —
 * is a defect in work the app did, and this repo fixes those in the loop rather than showing
 * them to the learner or throwing the lesson away. `longestProseRun` was already the measure
 * of the contract; this is the caller that acts on it. The finding is written the way the
 * review's own findings are written, so a repair session is told what to fix in the same
 * voice, and routed by id rather than by prose because we know exactly which lesson it is.
 */
export function interleavingFinding(node: ModuleNode): Finding | null {
  // WHY the capstone is exempt: it is a brief for a piece of work, not a lesson to read, and
  // the interleaving contract is about how a lesson is read.
  if (node.kind === 'capstone' || node.content === null) return null;
  const blocks = node.content.blocks;
  if (blocks === undefined || blocks.length === 0) {
    return {
      message:
        `Lesson ${node.ordinal} ("${node.title}") has no body: "blocks" is missing or empty, so the ` +
        'learner is given the opening explanation and nothing else. Write the lesson body as ' +
        'interleaved blocks — prose broken up by figures, tables, plots, interactives, checks or reveals.',
      affectedModules: [node.id],
    };
  }
  const run = longestProseRun(blocks);
  if (run > MAX_PROSE_RUN) {
    return {
      message:
        `Lesson ${node.ordinal} ("${node.title}") runs ${run} "prose" blocks in a row with nothing to ` +
        `look at or do between them. The contract allows at most ${MAX_PROSE_RUN}: break that run up ` +
        'with a figure, table, plot, interactive, check or reveal where the idea has just been made.',
      affectedModules: [node.id],
    };
  }
  return null;
}

/** Every written lesson in the graph that breaks the interleaving contract. */
export function interleavingFindings(graph: ModuleGraph): Finding[] {
  const findings: Finding[] = [];
  for (const node of graph.nodes) {
    const finding = interleavingFinding(node);
    if (finding !== null) findings.push(finding);
  }
  return findings;
}

export type RepairPlan = { node: ModuleNode; findings: string[] };

/**
 * WHY ranked by how many findings point at a lesson: a round is capped, and the lesson the
 * check complains about four times is where the course is most obviously broken. Ties go to
 * the earlier lesson, because a gap early in the sequence is read before the later one and
 * fixing it can dissolve the findings downstream of it.
 */
export function planRepairs(graph: ModuleGraph, findings: Finding[], limit = REPAIR_TARGETS_PER_ROUND): RepairPlan[] {
  const byModule = new Map<ModuleId, string[]>();
  for (const finding of findings) {
    for (const id of repairTargets(graph, finding)) {
      const list = byModule.get(id) ?? [];
      list.push(finding.message);
      byModule.set(id, list);
    }
  }
  const plans: RepairPlan[] = [];
  for (const [id, messages] of byModule) {
    const node = graph.nodes.find((n) => n.id === id);
    // WHY unwritten lessons are skipped: a repair session is asked to fix a lesson that
    // exists. A module with no content belongs to the writing phase, not to this one.
    if (node === undefined || node.content === null) continue;
    plans.push({ node, findings: messages });
  }
  plans.sort((a, b) => {
    if (a.findings.length !== b.findings.length) return b.findings.length - a.findings.length;
    return a.node.ordinal - b.node.ordinal;
  });
  return plans.slice(0, limit);
}

/**
 * The repair session is a writing session with a different job. It is given the lesson it
 * already wrote — its workspace is that lesson's own directory — and the findings against
 * it, and it hands back the whole lesson again. WHY a rewrite rather than a patch: the
 * contract that says what a lesson is has exactly one shape, and a session that returns
 * half a lesson has no way to be validated against it.
 */
export function repairObjectives(node: ModuleNode, findings: string[]): string[] {
  return [
    `Revise the existing lesson "${node.title}". Read content.json in your working directory first — that is the lesson as it stands, and your reply replaces it.`,
    'A consistency check across the whole course raised the problems below about THIS lesson. Fix every one of them.',
    ...findings.map((f, i) => `Problem ${i + 1}: ${f}`),
    'Keep everything the check did not object to: the same teaching, the same worked examples, the same figures and checks, in the same order. Add, re-scope or re-word only what the problems above require.',
    'Where a problem says another lesson owns something, say so in this lesson and name it, rather than teaching it twice.',
  ];
}

export type RepairRound = { attempted: number; repaired: ModuleId[]; failed: number };

/** One round of fixes. The re-check is the caller's, because the caller owns the counter
 *  that stops the loop. */
export async function runRepairRound(
  deps: OrchestratorDeps,
  topic: Topic,
  drivingQuestion: string,
  graph: ModuleGraph,
  findings: Finding[],
  signal: AbortSignal,
  onModule?: (node: ModuleNode) => void,
): Promise<RepairRound> {
  // WHY the structural findings are added here rather than by the caller: this is the only
  // door into a repair round, and the interleaving check costs nothing and needs no session.
  // Findings the review already raised are not raised twice.
  const structural = interleavingFindings(graph).filter(
    (s) => !findings.some((f) => f.message === s.message),
  );
  const plans = planRepairs(graph, [...findings, ...structural]);
  const repaired: ModuleId[] = [];
  let failed = 0;
  for (const plan of plans) {
    if (signal.aborted) break;
    onModule?.(plan.node);
    const outcome = await authorModule(
      deps,
      topic,
      drivingQuestion,
      graph,
      plan.node,
      repairObjectives(plan.node, plan.findings),
      signal,
    );
    // WHY a failed repair is counted and not noted: the lesson it failed to improve is
    // still the lesson the learner had a moment ago, and nothing about it got worse. The
    // record of the attempt belongs in the log, where the person maintaining the app can
    // see it, and not on the page of someone who came here to learn.
    if (outcome.ok) repaired.push(plan.node.id);
    else failed += 1;
  }
  log({
    level: 'info',
    event: 'curriculum-repair-round',
    component: 'C4',
    topicId: topic.id,
    findings: findings.length,
    attempted: plans.length,
    repaired: repaired.length,
    failed,
  });
  return { attempted: plans.length, repaired, failed };
}
