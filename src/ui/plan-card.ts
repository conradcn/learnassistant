// FRACTAL: implements F2 | component C10
import type { ModuleGraph, TopicExtension, TopicNote, TopicStatus } from '@/shapes';

/** The statuses that mean planning is under way right now, so there is nothing to press. */
export const PLANNING: readonly TopicStatus[] = ['queued', 'generating'];

/**
 * Which of the two authorised steps a subject is waiting on, or `null` when it is
 * waiting on neither.
 *
 * WHY this is a function and not an inline condition: the page asked `unwritten === 0`
 * on its own, and a subject with no outline has no unwritten lessons either — its count
 * is zero because nothing has been planned, not because everything has been written.
 * Those are opposite situations and only one of them means "no action left", so the one
 * subject that most needed the button was the only one that never got it.
 */
export function planStep(
  status: TopicStatus,
  graph: ModuleGraph,
  unwritten: number,
): 'plan' | 'write' | null {
  if (PLANNING.includes(status)) return null;
  if (graph.nodes.length === 0) return 'plan';
  return unwritten > 0 ? 'write' : null;
}

/**
 * Whether the "we are working on it" panel takes the whole screen, or sits above the
 * lessons that already exist.
 *
 * WHY: a subject is planned once but WRITTEN in passes — "this writes the next 10, so you
 * can start while the rest wait" is the whole point of the prep window. Both passes run
 * under the same `generating` status, so the second one replaced the graph with "Planning
 * your lessons…": pressing the button that promised the learner they could start now hid
 * every lesson they already had, and described writing as planning. The panel owns the
 * screen only while there is genuinely nothing to show.
 */
export function planningPanel(status: TopicStatus, graph: ModuleGraph): boolean {
  return PLANNING.includes(status) && graph.nodes.length === 0;
}

/** A later pass, writing more lessons behind a graph the learner can already read. */
export function writingMore(status: TopicStatus, graph: ModuleGraph): boolean {
  return PLANNING.includes(status) && graph.nodes.length > 0;
}

/**
 * Whether the last run this subject was given stopped without doing what it promised.
 *
 * WHY the note and not the status alone: `needs-attention` is also how a healthy research
 * pass hands the subject back — outline written, lessons still to come — so reading the
 * status by itself would dress up an ordinary "press the next button" as a crash. Every
 * path that abandons or degrades a run files a `generation-failure` note first, and that
 * note is cleared the moment a later pass succeeds, so the pair is what actually means
 * "the thing you started did not finish".
 *
 * WHY the page needs to know at all: the subject page told the learner "We are writing
 * your lessons now" and then never spoke again. A crashed run and a running one were the
 * same screen for as long as the learner cared to look at it.
 */
export function generationFailed(status: TopicStatus, notes: readonly TopicNote[]): boolean {
  return status === 'needs-attention' && notes.some((note) => note.kind === 'generation-failure');
}

/**
 * Whether the pass under way is planning an extension rather than writing lessons.
 *
 * WHY the page has to tell them apart: both run under `generating`, and the panel that
 * covers a run says "Writing more lessons…". An extension pass writes no lesson at all — it
 * works out which ones are missing — so for the minute it runs the page was describing work
 * nobody had authorised yet, and the lessons it named never appeared while it said so.
 */
export function planningExtension(extensions: readonly TopicExtension[]): boolean {
  return extensions.some((e) => e.modulesAdded === 0);
}

/**
 * One line for a goal this subject has already been carried to.
 *
 * WHY a request that has not been planned yet says so rather than "0 lessons": the record is
 * written when the learner presses, and the pass that fills in the count runs afterwards.
 * "Sufficient knowledge for the MCAT — 0 lessons" describes a press that failed; what
 * actually happened is that it has not been worked out yet.
 */
export function extensionLine(extension: TopicExtension): string {
  const goal = extension.goal.trim();
  if (extension.modulesAdded === 0) return `${goal} — being worked out now`;
  return `${goal} — ${extension.modulesAdded} lesson${extension.modulesAdded === 1 ? '' : 's'} added`;
}
