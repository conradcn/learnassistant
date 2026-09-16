// FRACTAL: implements F2, F12 | component C4
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  topicExtensionSchema,
  topicNoteSchema,
  topicStatusSchema,
  type ModuleId,
  type TopicExtension,
  type TopicId,
  type TopicNote,
  type TopicStatus,
} from '@/shapes';
import { paths } from '@/core/paths';
import { log } from '@/core/log';

export const topicStateSchema = z.object({
  status: topicStatusSchema,
  drivingQuestion: z.string().nullable(),
  notes: z.array(topicNoteSchema),
  reviewRuns: z.number().int().min(0),
  /**
   * Consecutive background recovery passes handed to a subject that is in trouble, since
   * the last one that wrote a lesson. WHY it is recorded and not just counted in memory:
   * the sweep that spends this budget runs on a timer in a process that restarts, and a
   * counter that resets with the process is not a budget at all — it is a subject retrying
   * a failing pass forever, one restart at a time. `.default(0)` so sidecars written before
   * this existed load as "no attempts spent" rather than as a corrupt state.
   */
  prepAttempts: z.number().int().min(0).default(0),
  /** `.default([])` so sidecars written before extensions existed load as "never extended". */
  extensions: z.array(topicExtensionSchema).default([]),
});
export type TopicOrchestrationState = z.infer<typeof topicStateSchema>;

export const DEFAULT_TOPIC_STATE: TopicOrchestrationState = {
  status: 'queued',
  drivingQuestion: null,
  notes: [],
  reviewRuns: 0,
  prepAttempts: 0,
  extensions: [],
};

const STATE_FILE = 'orchestration.json';

function topicDir(dataRoot: string, topicId: TopicId): string {
  return path.join(paths(dataRoot).topicsDir, topicId);
}

function stateFile(dataRoot: string, topicId: TopicId): string {
  return path.join(topicDir(dataRoot, topicId), STATE_FILE);
}

/**
 * WHY this is an error and not a status: a subject the learner deleted while it was being
 * written is not a subject in trouble, and every path that would record trouble writes it
 * to a sidecar inside the subject's own directory. Recreating that directory to say
 * "needs attention" left a course nothing could ever reach again — `reconcileTopic` only
 * walks subjects that still have a row, so the folder sat there forever describing a
 * subject the learner had thrown away. The work stops here instead, quietly.
 */
export class TopicDeletedError extends Error {
  readonly topicId: TopicId;

  constructor(topicId: TopicId) {
    super('the subject was deleted while its lessons were being written');
    this.name = 'TopicDeletedError';
    this.topicId = topicId;
  }
}

export function isTopicDeleted(e: unknown): e is TopicDeletedError {
  return e instanceof TopicDeletedError;
}

/**
 * The one place a subject's directory is allowed to come into existence. WHY it is
 * separate from `writeTopicState`: the state write is on every generation path, so if it
 * may create the directory then any of them can resurrect a deleted subject. Creation is
 * asked for explicitly, at the point a subject that still has a row is about to be worked
 * on; everywhere else, a missing directory means the subject is gone.
 */
export function ensureTopicDir(dataRoot: string, topicId: TopicId): void {
  mkdirSync(topicDir(dataRoot, topicId), { recursive: true, mode: 0o700 });
}

/**
 * Removes everything on disk that belongs to a deleted subject — its lessons, its
 * orchestration sidecar and the copy of the learner's own source material with them.
 *
 * WHY a failure here is logged and not raised: the rows are already gone, so throwing
 * would report a failure for a deletion that happened. What is left behind is a directory
 * nothing references, and the log line is how it gets found.
 */
export function discardTopicDirectory(dataRoot: string, topicId: TopicId): void {
  try {
    rmSync(topicDir(dataRoot, topicId), { recursive: true, force: true });
  } catch (cause) {
    log({
      level: 'warn',
      event: 'topic-directory-discard-failed',
      component: 'C4',
      topicId,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function fsyncPath(target: string, flags: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(target, flags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// WHY: C1's topics repo has no update method, so C4 keeps the generation-owned
// fields (status, driving question, notes) in a durable sidecar written with the
// same temp -> fsync -> rename -> fsync-dir protocol as content.json. A read
// that fails to parse degrades to the default rather than pretending the topic
// is fine.
export function readTopicState(dataRoot: string, topicId: TopicId): TopicOrchestrationState {
  const file = stateFile(dataRoot, topicId);
  if (!existsSync(file)) return { ...DEFAULT_TOPIC_STATE, notes: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {
      status: 'needs-attention',
      drivingQuestion: null,
      notes: [],
      reviewRuns: 0,
      prepAttempts: 0,
      extensions: [],
    };
  }
  const parsed = topicStateSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: 'needs-attention', drivingQuestion: null, notes: [], reviewRuns: 0, prepAttempts: 0, extensions: [] };
  }
  return parsed.data;
}

export function writeTopicState(dataRoot: string, topicId: TopicId, state: TopicOrchestrationState): TopicOrchestrationState {
  const validated = topicStateSchema.parse(state);
  const dir = topicDir(dataRoot, topicId);
  // WHY this refuses to create rather than mkdir-ing: see TopicDeletedError. The
  // directory is made by `ensureTopicDir` when work legitimately starts, and its absence
  // afterwards is the signal that the subject was deleted underneath this run.
  if (!existsSync(dir)) throw new TopicDeletedError(topicId);
  const file = stateFile(dataRoot, topicId);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(validated), { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(tmp, 0o600);
  fsyncPath(tmp, 'r+');
  renameSync(tmp, file);
  fsyncPath(dir, 'r');
  return validated;
}

export function setTopicStatus(dataRoot: string, topicId: TopicId, status: TopicStatus): TopicOrchestrationState {
  const current = readTopicState(dataRoot, topicId);
  return writeTopicState(dataRoot, topicId, { ...current, status });
}

/**
 * WHY the two of these exist: the background recovery loop (C4's prep sweep) must be able
 * to stop. A subject that fails the same pass every five minutes forever costs sessions
 * and never gets better, so each unasked-for pass handed to a subject in trouble spends
 * one attempt, and a pass that actually wrote a lesson gives the budget back — a course
 * being written a few lessons at a time across many passes is progress, not a loop.
 */
export function recordPrepAttempt(dataRoot: string, topicId: TopicId): TopicOrchestrationState {
  const current = readTopicState(dataRoot, topicId);
  return writeTopicState(dataRoot, topicId, { ...current, prepAttempts: current.prepAttempts + 1 });
}

/** Called when a pass made progress, or when the learner asked for one themselves. */
export function resetPrepAttempts(dataRoot: string, topicId: TopicId): TopicOrchestrationState {
  const current = readTopicState(dataRoot, topicId);
  if (current.prepAttempts === 0) return current;
  return writeTopicState(dataRoot, topicId, { ...current, prepAttempts: 0 });
}

export function addTopicNotes(dataRoot: string, topicId: TopicId, notes: TopicNote[]): TopicOrchestrationState {
  const current = readTopicState(dataRoot, topicId);
  const seen = new Set(current.notes.map((n) => `${n.kind}:${n.message}`));
  const merged = [...current.notes];
  for (const note of notes) {
    const key = `${note.kind}:${note.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(topicNoteSchema.parse(note));
  }
  return writeTopicState(dataRoot, topicId, { ...current, notes: merged });
}

/**
 * WHY: a failure note describes ONE attempt, but notes only ever accumulated. A subject
 * whose planning was interrupted kept telling the learner "Planning stopped before it
 * finished" for the rest of its life — including after the outline had landed and the page
 * was offering "Write the lessons" right below the warning that said to plan them. A new
 * attempt therefore clears the last attempt's failures; notes about the content itself
 * (discontinuities, coercions) survive, because they still describe the lessons on disk.
 */
export function clearGenerationFailureNotes(dataRoot: string, topicId: TopicId): TopicOrchestrationState {
  const current = readTopicState(dataRoot, topicId);
  return writeTopicState(dataRoot, topicId, {
    ...current,
    notes: current.notes.filter((n) => n.kind !== 'generation-failure'),
  });
}

/**
 * WHY narrower than clearGenerationFailureNotes: the writing phase re-attempts the
 * lessons, not the outline. Clearing every failure note at the top of it also threw away
 * "Could not research an outline — split up by subtopic instead", which is still true of
 * the plan and is the only warning that the plan is a fallback. A note is retired exactly
 * when this run is about to redo the thing it describes, and `affectedModules` is what
 * says which thing that is.
 */
export function clearGenerationFailureNotesFor(
  dataRoot: string,
  topicId: TopicId,
  moduleIds: Iterable<ModuleId>,
): TopicOrchestrationState {
  const redoing = new Set<ModuleId>(moduleIds);
  const current = readTopicState(dataRoot, topicId);
  return writeTopicState(dataRoot, topicId, {
    ...current,
    notes: current.notes.filter(
      (n) => n.kind !== 'generation-failure' || !n.affectedModules.some((id) => redoing.has(id)),
    ),
  });
}

/**
 * WHY: a review's findings describe the curriculum the reviewer was shown. When a later
 * pass writes lessons that were missing and the review runs again, the earlier findings
 * are not extra detail — they are an account of a curriculum that no longer exists. On a
 * real run this left the learner holding seventeen notes where the reviewer had raised
 * ten, including one objecting that the project brief was "Not written yet" beside the
 * brief that had just been written. The fresh review supersedes the stale one, so the
 * previous round is retired rather than merged with it.
 *
 * Only the review's own findings are retired. Failure notes are handled by the clears
 * above, and notes raised while writing a specific lesson still describe that lesson.
 */
export function clearSupersededReviewNotes(dataRoot: string, topicId: TopicId): TopicOrchestrationState {
  const current = readTopicState(dataRoot, topicId);
  return writeTopicState(dataRoot, topicId, {
    ...current,
    notes: current.notes.filter((n) => n.kind !== 'discontinuity' && n.kind !== 'cross-topic'),
  });
}

export function dismissTopicNote(dataRoot: string, topicId: TopicId, message: string): TopicOrchestrationState {
  const current = readTopicState(dataRoot, topicId);
  return writeTopicState(dataRoot, topicId, {
    ...current,
    notes: current.notes.filter((n) => n.message !== message),
  });
}

/** Records that this subject has been carried to a further goal, and by how many lessons. */
export function recordTopicExtension(
  dataRoot: string,
  topicId: TopicId,
  extension: TopicExtension,
): TopicOrchestrationState {
  const current = readTopicState(dataRoot, topicId);
  return writeTopicState(dataRoot, topicId, {
    ...current,
    extensions: [...current.extensions, topicExtensionSchema.parse(extension)],
  });
}

/**
 * The extension this subject has asked for and not yet had planned, if any.
 *
 * WHY the goal lives here rather than on the job: a job row carries a topic id and a module
 * id, and nothing else. The alternative was a free-text payload column on every job kind for
 * the sake of one, so the request is recorded against the subject when it is made and read
 * back by the pass that serves it — which is also what puts it on the page in the meantime.
 */
export function pendingExtension(state: TopicOrchestrationState): TopicExtension | null {
  for (let i = state.extensions.length - 1; i >= 0; i -= 1) {
    if (state.extensions[i].modulesAdded === 0) return state.extensions[i];
  }
  return null;
}

/** Closes the pending extension out with the number of lessons the pass actually added. */
export function recordExtensionModules(
  dataRoot: string,
  topicId: TopicId,
  modulesAdded: number,
): TopicOrchestrationState {
  const current = readTopicState(dataRoot, topicId);
  const pending = pendingExtension(current);
  if (pending === null) return current;
  let closed = false;
  const extensions = [...current.extensions]
    .reverse()
    .map((e) => {
      if (closed || e.modulesAdded !== 0) return e;
      closed = true;
      return { ...e, modulesAdded };
    })
    .reverse();
  return writeTopicState(dataRoot, topicId, { ...current, extensions });
}
