// FRACTAL: implements F1, F2, F12 | component C4
import {
  generationProgressSchema,
  jobSchema,
  type GenerationProgress,
  type Job,
  type JobKind,
  type ModuleGraph,
  type ModuleId,
  type ModuleNode,
  type Topic,
  type TopicId,
  type TopicNote,
  type TopicStatus,
} from '@/shapes';
import { err, AppError } from '@/core/errors';
import { log } from '@/core/log';
import type { NewTopic } from '@/store/topics';
import { newJobId, newModuleId, nowIso } from '@/orchestrator/ids';
import { planFor, type DetourRequest, type ExtensionRequest, type GenerationPlan, type ResearchOutline } from '@/orchestrator/plan';
import { runResearch } from '@/orchestrator/research';
import { loadMaterial } from '@/source/material';
import { authorModule } from '@/orchestrator/author-module';
import { deferredCount, prepWindow, unwrittenModules } from '@/orchestrator/prep-window';
import { authorCapstoneSpec, capstoneLeafPrereqs } from '@/orchestrator/capstone-spec';
import { REVIEW_UNAVAILABLE_NOTE, crossTopicCandidates, runDiscontinuityReview, validateGraph } from '@/orchestrator/discontinuity';
import { interleavingFindings, runRepairRound, type Finding } from '@/orchestrator/repair';
import { MAX_REPAIR_ROUNDS } from '@/orchestrator/repair.budget';
import { detourAllowedForStatus, DETOUR_BLOCKED_MESSAGE, insertDetour, planDetour } from '@/orchestrator/detour';
import {
  EXTEND_BLOCKED_MESSAGE,
  EXTEND_UNPLANNED_MESSAGE,
  extendAllowedForStatus,
  extensionSize,
  insertExtension,
  planExtension,
  runExtensionResearch,
} from '@/orchestrator/extend';
import { readInFlightIndex, reconcileTopic, writeInFlightIndex } from '@/orchestrator/reconcile';
import { addTopicNotes, pendingExtension, recordExtensionModules, recordTopicExtension, clearGenerationFailureNotes, clearGenerationFailureNotesFor, clearSupersededReviewNotes, discardTopicDirectory, dismissTopicNote, ensureTopicDir, isTopicDeleted, readTopicState, resetPrepAttempts, setTopicStatus, writeTopicState } from '@/orchestrator/topic-state';
import type { OrchestratorDeps } from '@/orchestrator/session';

export { type OrchestratorDeps } from '@/orchestrator/session';

export const OVERALL_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * How many jobs the pump may have open at once.
 *
 * WHY it exists at all when C2 already holds the session limit: a job is not a session. One
 * `generate-topic` is a research session followed by a fan-out of a whole window of lessons,
 * and draining jobs one at a time meant the second subject in the queue waited out the first
 * subject's entire course — fifteen minutes of a queued job with permits going spare, which
 * is what the queue looked like in practice. Jobs are independent of each other, so they run
 * beside each other, and the provider load they add is still bounded underneath by
 * `sessionConcurrency`. This number is only how many can be in the air, not how much they
 * may spend.
 */
export const MAX_CONCURRENT_JOBS = 8;

function toNewTopic(topic: Topic): NewTopic {
  return {
    subject: topic.subject,
    level: topic.level,
    levelDetail: topic.levelDetail,
    purpose: topic.purpose,
    diagnostic: topic.diagnostic,
  };
}

/** The one note that a landed outline makes false. Named so the writing phase can
 *  retire it instead of leaving it to contradict the button beneath it. */
export const STALL_MESSAGE =
  'Planning stopped before it finished. Choose "Plan the lessons" to pick it up again.';

/** The whole-run failure summaries. They name no module, so unlike the per-lesson notes
 *  the next run has to retire them by message — see runAuthoringPhase. */
const NOTHING_WRITTEN_MESSAGES: readonly string[] = [
  'None of the lessons could be written because the AI assistant is not available. Fix that, then choose "Retry topic".',
  'None of the lessons could be written this time. Choose "Retry topic" to try again.',
];

export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly inFlight = new Map<string, { controller: AbortController; topicId: TopicId }>();
  private readonly retained = new Set<Promise<unknown>>();
  private readonly progressCache = new Map<TopicId, GenerationProgress>();
  private readonly listeners = new Map<TopicId, Set<(p: GenerationProgress) => void>>();
  private readonly sessionCounts = new Map<TopicId, number>();
  private closed = false;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  planFor(input: NewTopic): GenerationPlan {
    return planFor(input);
  }

  sessionsDispatchedFor(topicId: TopicId): number {
    return this.sessionCounts.get(topicId) ?? 0;
  }

  private requireTopic(topicId: TopicId): Topic {
    const row = this.deps.store.topics.get(topicId);
    if (row === null || 'degraded' in row) {
      throw err('not-found', { detail: 'topic not found or degraded', userMessage: 'We could not find that subject.' });
    }
    // WHY here: this is the gate every entry point passes through, and the only place that
    // has just proved the subject still has a row. `writeTopicState` will not create the
    // directory itself, so that a run whose subject was deleted underneath it cannot put
    // one back.
    ensureTopicDir(this.deps.dataRoot, topicId);
    return row;
  }

  private enqueue(kind: JobKind, topicId: TopicId, moduleId: ModuleId | null): Job {
    const job: Job = jobSchema.parse({
      id: newJobId(),
      kind,
      topicId,
      moduleId,
      status: 'queued',
      attempts: 0,
      startedAt: null,
      finishedAt: null,
      error: null,
    });
    const stored = this.deps.store.jobs.enqueue(job);
    log({ level: 'info', event: 'orchestrator-job-queued', component: 'C4', jobId: stored.id, kind, topicId });
    return stored;
  }

  enqueueTopic(topicId: TopicId): Job {
    this.requireTopic(topicId);
    // The learner asking for this subject by name is a fresh start; whatever the background
    // recovery loop spent on it before is not held against the run they just asked for.
    resetPrepAttempts(this.deps.dataRoot, topicId);
    setTopicStatus(this.deps.dataRoot, topicId, 'queued');
    this.sessionCounts.set(topicId, 0);
    return this.enqueue('generate-topic', topicId, null);
  }

  // WHY it is a separate entry point from enqueueTopic: research runs first because
  // until it lands there are no lessons to write. Once the graph exists this queues
  // the second half of the same generation — one session per module, the capstone
  // spec and the single review — against the outline research produced.
  resumeGeneration(topicId: TopicId): Job {
    this.requireTopic(topicId);

    if (this.deps.store.modules.graph(topicId).nodes.length === 0) {
      throw err('conflict', {
        detail: 'resumeGeneration called before the outline exists',
        userMessage: 'We are still working out the lesson plan. Try again in a moment.',
      });
    }
    return this.enqueue('generate-topic', topicId, null);
  }

  retryModule(topicId: TopicId, moduleId: ModuleId): Job {
    this.requireTopic(topicId);
    const graph = this.deps.store.modules.graph(topicId);
    const node = graph.nodes.find((n) => n.id === moduleId);
    if (node === undefined) {
      throw err('not-found', { detail: 'module not found for retry', userMessage: 'We could not find that lesson.' });
    }
    return this.enqueue('author-module', topicId, moduleId);
  }

  requestDetour(req: DetourRequest): Job {
    this.requireTopic(req.topicId);
    const state = readTopicState(this.deps.dataRoot, req.topicId);
    if (!detourAllowedForStatus(state.status)) {
      throw err('conflict', { detail: `detour requested while topic is ${state.status}`, userMessage: DETOUR_BLOCKED_MESSAGE });
    }
    const graph = this.deps.store.modules.graph(req.topicId);
    const plan = planDetour(graph, req);
    this.deps.store.modules.upsertGraph(insertDetour(graph, plan));
    return this.enqueue('detour', req.topicId, plan.node.id);
  }

  /**
   * The learner asking for the course they already have to carry them somewhere further:
   * "Practical Biology" extended to "sufficient knowledge for the MCAT".
   *
   * WHY it is queued rather than done here: working out WHICH lessons a further goal needs,
   * given the ones this course already has, is a research pass — the same session kind that
   * planned the course, over a graph instead of over an empty page. Nothing is added to the
   * graph on this call; the job adds it, and the writing is authorised separately by the
   * button that was already there for the lessons the plan has not written yet.
   */
  requestExtension(req: ExtensionRequest): Job {
    this.requireTopic(req.topicId);
    const state = readTopicState(this.deps.dataRoot, req.topicId);
    if (!extendAllowedForStatus(state.status)) {
      throw err('conflict', {
        detail: `extension requested while topic is ${state.status}`,
        userMessage: EXTEND_BLOCKED_MESSAGE,
      });
    }
    if (this.deps.store.modules.graph(req.topicId).nodes.length === 0) {
      throw err('conflict', {
        detail: 'extension requested for a topic with no outline',
        userMessage: EXTEND_UNPLANNED_MESSAGE,
      });
    }
    // The goal rides on the job through the state file rather than on the job row: a job
    // carries a topic and a module and nothing else, and adding a payload column for one
    // kind would put an untyped blob on every other kind too.
    recordTopicExtension(this.deps.dataRoot, req.topicId, {
      goal: req.goal.trim(),
      modulesAdded: 0,
      createdAt: nowIso(),
    });
    setTopicStatus(this.deps.dataRoot, req.topicId, 'queued');
    return this.enqueue('extend', req.topicId, null);
  }

  /** What pressing "Extend" will cost, in lessons, before it is pressed. */
  extensionSizeFor(goal: string): number {
    return extensionSize(goal);
  }

  requestRemedial(moduleId: ModuleId, concept: string): Job {
    const topicId = this.topicIdOfModule(moduleId);
    this.requireTopic(topicId);
    const graph = this.deps.store.modules.graph(topicId);
    const node: ModuleNode = {
      id: newModuleId(),
      topicId,
      title: `A closer look at ${concept.trim().slice(0, 120)}`,
      ordinal: graph.nodes.reduce((max, n) => Math.max(max, n.ordinal), 0) + 1,
      kind: 'remedial',
      testOutEligible: false,
      estimatedMinutes: 10,
      state: 'available',
      content: null,
    };
    this.deps.store.modules.upsertGraph({
      ...graph,
      nodes: [...graph.nodes, node],
      edges: [...graph.edges, { from: moduleId, to: node.id }],
    });
    // WHY the job kind is `detour` and not `author-module`: a remedial lesson is an
    // insertion into a graph that is already written, and runSingleModule reads the
    // kind to decide it is writing one new node rather than re-writing a planned one.
    return this.enqueue('detour', topicId, node.id);
  }

  private topicIdOfModule(moduleId: ModuleId): TopicId {
    for (const topic of this.deps.store.topics.list()) {
      if ('degraded' in topic) continue;
      if (this.deps.store.modules.graph(topic.id).nodes.some((n) => n.id === moduleId)) return topic.id;
    }
    throw err('not-found', { detail: 'module id belongs to no topic', userMessage: 'We could not find that lesson.' });
  }

  progress(topicId: TopicId): GenerationProgress {
    const cached = this.progressCache.get(topicId);
    if (cached) return cached;
    const graph = this.deps.store.modules.graph(topicId);
    const state = readTopicState(this.deps.dataRoot, topicId);
    const authorable = graph.nodes.filter((n) => n.kind !== 'capstone');
    const phase: GenerationProgress['phase'] =
      state.status === 'queued' || graph.nodes.length === 0
        ? 'research'
        : state.status === 'generating'
          ? 'authoring'
          : 'done';
    return generationProgressSchema.parse({
      topicId,
      phase,
      modulesTotal: authorable.length,
      modulesDone: authorable.filter((n) => n.content !== null).length,
      currentModule: null,
      lastTickAt: nowIso(),
    });
  }

  private tick(topicId: TopicId, phase: GenerationProgress['phase'], total: number, done: number, current: string | null): void {
    const next = generationProgressSchema.parse({
      topicId,
      phase,
      modulesTotal: total,
      modulesDone: done,
      currentModule: current,
      lastTickAt: nowIso(),
    });
    this.progressCache.set(topicId, next);
    for (const listener of this.listeners.get(topicId) ?? []) listener(next);
  }

  // WHY: the SSE source for C9. The queue of pending ticks is bounded, so a
  // consumer that stops reading drops old ticks instead of growing forever.
  subscribe(topicId: TopicId): AsyncIterable<GenerationProgress> {
    return {
      // WHY: an arrow closes over the engine lexically, so the iterator needs no
      // alias for `this`.
      [Symbol.asyncIterator]: (): AsyncIterator<GenerationProgress> => {
        const pending: GenerationProgress[] = [];
        let resolveNext: ((v: IteratorResult<GenerationProgress>) => void) | null = null;
        const listener = (p: GenerationProgress): void => {
          if (resolveNext) {
            const r = resolveNext;
            resolveNext = null;
            r({ value: p, done: false });
            return;
          }
          if (pending.length >= 64) pending.shift();
          pending.push(p);
        };
        const set = this.listeners.get(topicId) ?? new Set();
        set.add(listener);
        this.listeners.set(topicId, set);
        const detach = (): void => {
          set.delete(listener);
          if (set.size === 0) this.listeners.delete(topicId);
        };
        const engineClosed = (): boolean => this.closed;
        return {
          next: (): Promise<IteratorResult<GenerationProgress>> => {
            const queued = pending.shift();
            if (queued) return Promise.resolve({ value: queued, done: false });
            if (engineClosed()) {
              detach();
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise((resolve) => {
              resolveNext = resolve;
            });
          },
          return: (): Promise<IteratorResult<GenerationProgress>> => {
            detach();
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }

  // WHY: jobs left `running` when the process died have no owner. They are reset
  // to `queued` with attempts preserved, and their module directories are
  // reconciled back to the last committed state before anything runs again.
  resetRunningJobsAtBoot(): string[] {
    // WHY the store, not the index: `readInFlightIndex` is a file written next to the
    // data root, and a job claimed by a process that died before that write — or whose
    // index file was lost with a restore — was never listed there. Those rows stayed
    // `running`, and `claimNext` only ever looks at `queued`, so they were owned by
    // nobody while their subject sat on "Planning your lessons…" with nothing coming.
    // The jobs table is the one record that is always written inside the claim
    // transaction, so recovery asks it and treats the index as a hint.
    const requeued = this.deps.store.jobs.requeueRunning();
    const inFlight = readInFlightIndex(this.deps.dataRoot);
    if (inFlight.length > 0) writeInFlightIndex(this.deps.dataRoot, []);
    for (const topic of this.deps.store.topics.list()) {
      if ('degraded' in topic) continue;
      // The subject has a row, so recovery is allowed to put its directory back if a
      // restore or a half-finished delete lost it. Nothing after this point may.
      ensureTopicDir(this.deps.dataRoot, topic.id);
      reconcileTopic(this.deps.store, this.deps.dataRoot, topic.id);
      const state = readTopicState(this.deps.dataRoot, topic.id);
      if (state.status === 'generating') setTopicStatus(this.deps.dataRoot, topic.id, 'queued');
      // WHY: a subject waiting on a job that no longer exists waits forever. The page
      // shows the planning spinner for `queued` and `generating` and hides the button
      // that would start the work, so "nothing in the queue for this subject" renders as
      // "still working" with no way out. Handing it back as `needs-attention` puts the
      // door back on screen.
      if (this.deps.store.jobs.pendingFor(topic.id) === 0) {
        const status = readTopicState(this.deps.dataRoot, topic.id).status;
        if (status === 'queued' || status === 'generating') this.stall(topic.id);
      }
    }
    log({ level: 'info', event: 'orchestrator-boot-reset', component: 'C4', requeued: requeued.length });
    return requeued;
  }

  // WHY: every path that abandons a subject mid-plan goes through here, so the status
  // the learner sees and the note explaining it can never come apart.
  private stall(topicId: TopicId): void {
    addTopicNotes(this.deps.dataRoot, topicId, [
      {
        kind: 'generation-failure',
        message: STALL_MESSAGE,
        affectedModules: [],
        createdAt: nowIso(),
      },
    ]);
    setTopicStatus(this.deps.dataRoot, topicId, 'needs-attention');
  }

  private topicIsGone(topicId: TopicId): boolean {
    return this.deps.store.topics.get(topicId) === null;
  }

  /**
   * The quiet ending for a job whose subject was deleted while it ran. Nothing is written
   * to disk and no failure is recorded: the job row went with the subject, so there is
   * nothing left to mark, and the only thing worth saying is that this happened.
   */
  private abandonDeleted(job: Job): Job {
    discardTopicDirectory(this.deps.dataRoot, job.topicId);
    log({ level: 'info', event: 'orchestrator-job-topic-deleted', component: 'C4', jobId: job.id, kind: job.kind, topicId: job.topicId });
    return { ...job, status: 'cancelled' };
  }

  /**
   * Stops everything in flight for one subject. WHY deletion goes through here rather than
   * just dropping the rows: an aborted session stops dispatching more work, so the delete
   * costs one interrupted session instead of a whole course's worth of them being written
   * for a subject the learner has already thrown away.
   */
  cancelTopic(topicId: TopicId): string[] {
    const cancelled: string[] = [];
    for (const [jobId, entry] of this.inFlight) {
      if (entry.topicId !== topicId) continue;
      entry.controller.abort();
      cancelled.push(jobId);
    }
    this.sessionCounts.delete(topicId);
    this.progressCache.delete(topicId);
    return cancelled;
  }

  async runNext(): Promise<Job | null> {
    if (this.closed) return null;
    const job = this.deps.store.jobs.claimNext();
    if (job === null) return null;

    const controller = new AbortController();
    this.inFlight.set(job.id, { controller, topicId: job.topicId });
    const overall = setTimeout(() => controller.abort(), OVERALL_TIMEOUT_MS);
    let task: Promise<unknown> | null = null;
    try {
      // WHY: this index write sat above the try, so a failure to write it escaped
      // runNext entirely. runNext's only caller on the request path is the
      // fire-and-forget pump, so that throw became a floating rejection with the
      // job left claimed as `running` forever. Everything that can fail is now
      // inside the block that marks the job failed.
      writeInFlightIndex(this.deps.dataRoot, [...this.inFlight.keys()]);
      task = this.execute(job, controller.signal);
      this.retained.add(task);
      await task;
      if (this.topicIsGone(job.topicId)) return this.abandonDeleted(job);
      this.deps.store.jobs.finish(job.id, controller.signal.aborted ? 'cancelled' : 'succeeded');
      return { ...job, status: controller.signal.aborted ? 'cancelled' : 'succeeded' };
    } catch (e) {
      // WHY this is checked before the error is classified: deleting a subject removes its
      // rows, so work still in flight for it fails on a foreign key, on a missing job row,
      // or on its own state sidecar being gone. None of that is a fault — the learner
      // asked for the subject to go — and recording it as one wrote a `needs-attention`
      // sidecar that recreated the deleted subject's directory, unreachable forever after.
      if (isTopicDeleted(e) || this.topicIsGone(job.topicId)) return this.abandonDeleted(job);
      const shape = e instanceof AppError ? e.toShape() : err('internal', { detail: 'job failed', cause: e }).toShape();
      this.deps.store.jobs.finish(job.id, 'failed', shape);
      setTopicStatus(this.deps.dataRoot, job.topicId, 'needs-attention');
      return { ...job, status: 'failed', error: shape };
    } finally {
      clearTimeout(overall);
      if (task !== null) this.retained.delete(task);
      this.inFlight.delete(job.id);
      // WHY a sweep and not just the error path: a run can also finish cleanly in the
      // window between the delete and its last write, and anything it left behind belongs
      // to a subject that no longer exists.
      if (this.topicIsGone(job.topicId)) discardTopicDirectory(this.deps.dataRoot, job.topicId);
      try {
        writeInFlightIndex(this.deps.dataRoot, [...this.inFlight.keys()]);
      } catch (e) {
        log({
          level: 'warn',
          event: 'orchestrator-inflight-index-unwritable',
          component: 'C4',
          cause: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  // WHY the workers share one counter rather than taking a slice each: `claimNext` is the
  // only thing that decides which job is next, and it is a single synchronous claim inside
  // the jobs transaction, so two workers can never take the same row. A worker stops on the
  // first empty claim; the others keep draining, and `pumpJobs`' wake flag brings the pump
  // back for anything enqueued in the meantime.
  async drain(maxJobs = 64, width = MAX_CONCURRENT_JOBS): Promise<Job[]> {
    const done: Job[] = [];
    let claimed = 0;
    const worker = async (): Promise<void> => {
      while (claimed < maxJobs) {
        claimed += 1;
        const job = await this.runNext();
        if (job === null) return;
        done.push(job);
      }
    };
    const workers = Array.from({ length: Math.max(1, Math.min(width, maxJobs)) }, () => worker());
    await Promise.all(workers);
    return done;
  }

  private execute(job: Job, signal: AbortSignal): Promise<void> {
    if (job.kind === 'generate-topic') return this.runGeneration(job, signal);
    if (job.kind === 'author-module' || job.kind === 'detour') return this.runSingleModule(job, signal);
    if (job.kind === 'extend') return this.runExtensionPhase(job, signal);
    throw err('validation', { detail: `orchestrator cannot run job kind ${job.kind}` });
  }

  private countSession(topicId: TopicId): void {
    this.sessionCounts.set(topicId, (this.sessionCounts.get(topicId) ?? 0) + 1);
  }

  private buildGraph(topic: Topic, outline: ResearchOutline, ids: ModuleId[]): ModuleGraph {
    const nodes: ModuleNode[] = outline.modules.map((m, i) => ({
      id: ids[i],
      topicId: topic.id,
      title: m.title,
      ordinal: i + 1,
      kind: 'module',
      testOutEligible: m.testOutEligible,
      estimatedMinutes: m.estimatedMinutes,
      state: 'available',
      content: null,
    }));
    const edges = outline.edges.map((e) => ({ from: ids[e.from], to: ids[e.to] }));
    const capstone: ModuleNode = {
      id: newModuleId(),
      topicId: topic.id,
      title: `Project: ${topic.subject}`,
      ordinal: nodes.length + 1,
      kind: 'capstone',
      testOutEligible: false,
      estimatedMinutes: 120,
      state: 'not-yet-recommended',
      content: null,
    };
    const graph: ModuleGraph = { topicId: topic.id, nodes: [...nodes, capstone], edges, entryModules: [] };
    const capstoneEdges = capstoneLeafPrereqs(graph, capstone.id).map((from) => ({ from, to: capstone.id }));
    return { ...graph, edges: [...edges, ...capstoneEdges] };
  }

  private runGeneration(job: Job, signal: AbortSignal): Promise<void> {
    const hasGraph = this.deps.store.modules.graph(job.topicId).nodes.length > 0;
    return hasGraph ? this.runAuthoringPhase(job, signal) : this.runResearchPhase(job, signal);
  }

  private async runResearchPhase(job: Job, signal: AbortSignal): Promise<void> {
    const topic = this.requireTopic(job.topicId);
    // The material's own unit count is an input to the plan: a course whose syllabus names
    // fourteen units and whose estimate is ten would otherwise drop four of them silently.
    const material = loadMaterial(this.deps.store, this.deps.dataRoot, topic.id);
    const plan = planFor(toNewTopic(topic), material?.units.length ?? 0);
    setTopicStatus(this.deps.dataRoot, topic.id, 'generating');
    clearGenerationFailureNotes(this.deps.dataRoot, topic.id);
    const notes: TopicNote[] = [];

    this.tick(topic.id, 'research', plan.estimatedModules, 0, null);
    const research = await runResearch(this.deps, topic, plan, newModuleId(), signal);
    this.countSession(topic.id);
    if (research.failureReason !== null) {
      notes.push({ kind: 'generation-failure', message: research.failureReason, affectedModules: [], createdAt: nowIso() });
    }
    const drivingQuestion = research.outline.drivingQuestion;
    writeTopicState(this.deps.dataRoot, topic.id, {
      ...readTopicState(this.deps.dataRoot, topic.id),
      status: 'generating',
      drivingQuestion,
    });

    const initial = validateGraph(this.buildGraph(topic, research.outline, research.ids));
    // WHY logged, not noted: validateGraph has already corrected the outline it was given.
    // See the review phase below for the whole of this reasoning.
    for (const issue of initial.validation.issues) {
      log({
        level: 'info',
        event: 'curriculum-graph-repaired',
        component: 'C4',
        topicId: topic.id,
        detail: issue.message,
        affectedModules: issue.affectedModules,
      });
    }
    this.deps.store.modules.upsertGraph(initial.graph);
    const authorable = initial.graph.nodes.filter((n) => n.kind !== 'capstone').length;
    this.tick(topic.id, 'authoring', authorable, 0, null);

    // WHY the topic is handed back rather than rolled straight on: research lands an
    // outline and nothing else. Nothing enqueued the writing pass and nothing moved the
    // status off `generating`, so the queue went empty with the subject stuck on "We are
    // planning your lessons" forever: an outline in the store, no lessons in it, and no
    // way forward on the page. Handing it back puts the plan on screen next to the button
    // that starts the writing. No note is filed for it — the page says what is missing and
    // what to press, and a note here would follow the topic all the way to
    // `ready-with-notes` after the lessons had in fact been written.
    addTopicNotes(this.deps.dataRoot, topic.id, notes);
    setTopicStatus(this.deps.dataRoot, topic.id, 'needs-attention');
  }

  /**
   * One pass that grows an existing course to a further goal.
   *
   * WHY it ends by handing the subject back rather than rolling on into the writing: this is
   * the research half of a generation, and it ends exactly where research ends — with a plan
   * on the page, the new lessons named and unwritten, and the button beneath them saying how
   * many the next press writes. The learner authorised planning the extension; they have not
   * yet authorised a course's worth of writing sessions, and the prep window is what asks.
   */
  private async runExtensionPhase(job: Job, signal: AbortSignal): Promise<void> {
    const topic = this.requireTopic(job.topicId);
    const state = readTopicState(this.deps.dataRoot, topic.id);
    const pending = pendingExtension(state);
    if (pending === null) {
      // Nothing to do, and nothing wrong: the request was already served, or the subject was
      // reset underneath it. Handing back the status it would have ended with anyway.
      setTopicStatus(this.deps.dataRoot, topic.id, 'needs-attention');
      return;
    }
    const before = this.deps.store.modules.graph(topic.id);
    const drivingQuestion = state.drivingQuestion ?? `What does it really take to understand ${topic.subject}?`;
    setTopicStatus(this.deps.dataRoot, topic.id, 'generating');
    this.tick(topic.id, 'research', extensionSize(pending.goal), 0, null);

    const research = await runExtensionResearch(this.deps, topic, pending.goal, drivingQuestion, before, signal);
    this.countSession(topic.id);

    const plan = planExtension(before, research.outline);
    const grown = validateGraph(insertExtension(before, plan));
    // As in the research phase: validateGraph has already corrected what it names, so the
    // record goes to the log rather than to a learner who cannot act on it.
    for (const issue of grown.validation.issues) {
      log({
        level: 'info',
        event: 'curriculum-graph-repaired',
        component: 'C4',
        topicId: topic.id,
        detail: issue.message,
        affectedModules: issue.affectedModules,
      });
    }
    this.deps.store.modules.upsertGraph(grown.graph);
    recordExtensionModules(this.deps.dataRoot, topic.id, plan.nodes.length);
    log({
      level: 'info',
      event: 'curriculum-extended',
      component: 'C4',
      topicId: topic.id,
      detail: pending.goal,
      modulesAdded: plan.nodes.length,
    });

    if (research.failureReason !== null) {
      addTopicNotes(this.deps.dataRoot, topic.id, [
        { kind: 'generation-failure', message: research.failureReason, affectedModules: [], createdAt: nowIso() },
      ]);
    }
    const authorable = grown.graph.nodes.filter((n) => n.kind !== 'capstone').length;
    this.tick(topic.id, 'done', authorable, authorable - unwrittenModules(grown.graph).length, null);
    setTopicStatus(this.deps.dataRoot, topic.id, 'needs-attention');
  }

  private async runAuthoringPhase(job: Job, signal: AbortSignal): Promise<void> {
    const topic = this.requireTopic(job.topicId);
    setTopicStatus(this.deps.dataRoot, topic.id, 'generating');
    dismissTopicNote(this.deps.dataRoot, topic.id, STALL_MESSAGE);
    const notes: TopicNote[] = [];
    const outlineState = readTopicState(this.deps.dataRoot, topic.id);
    const drivingQuestion = outlineState.drivingQuestion ?? `What does it really take to understand ${topic.subject}?`;
    const initial = { graph: this.deps.store.modules.graph(topic.id) };

    // WHY the window and not every unwritten lesson: the plan is allowed to be a degree's
    // worth of material, and writing all of it before the learner has read the first lesson
    // spends every session up front on lessons they may never reach. This pass writes what
    // is next in the prerequisite graph; the subject page then offers the pass after it.
    const authorable = prepWindow(initial.graph);

    // WHY here, before a single session runs: a `generation-failure` note describes one
    // ATTEMPT, and this is the next attempt at exactly the lessons it names. Leaving them
    // standing is not a cosmetic wart — a real run that recovered ten lessons still showed
    // the learner "Authoring failed" for all ten, and "The project brief could not be
    // written" beside the brief it had just written. The subject read as broken while every
    // page under it worked. Scoped by `affectedModules` so notes about work this run is NOT
    // redoing — above all "Could not research an outline", which still describes the plan —
    // survive; and the two whole-run summaries, which name no module, go by message.
    const rewriting = authorable.map((n) => n.id);
    clearGenerationFailureNotesFor(this.deps.dataRoot, topic.id, rewriting);
    for (const message of NOTHING_WRITTEN_MESSAGES) {
      dismissTopicNote(this.deps.dataRoot, topic.id, message);
    }

    let done = 0;
    const failures: { title: string; code: string }[] = [];
    this.tick(topic.id, 'authoring', authorable.length, 0, null);

    // WHY the fan-out is unbounded here: C2's session runner holds the only concurrency
    // limit in the app (config.sessionConcurrency), so a second one at this layer would
    // just be a number to keep in sync with it. Every task is awaited together so none is
    // garbage-collected mid-flight.
    const tasks = authorable.map((node) =>
      (async () => {
        if (signal.aborted) return;
        const graph = this.deps.store.modules.graph(topic.id);
        const live = graph.nodes.find((n) => n.id === node.id) ?? node;
        const objectives = [`Understand ${live.title}.`, `Connect it back to: ${drivingQuestion}`];
        const outcome = await authorModule(this.deps, topic, drivingQuestion, graph, live, objectives, signal);
        this.countSession(topic.id);
        if (outcome.ok) {
          done += 1;
          // WHY logged rather than noted: a coercion is something the app already put
          // right — a video link it would not trust, replaced with the written version.
          // The lesson on the page is complete, and telling the learner that a link they
          // never saw was refused files a defect against a reader who cannot act on it.
          for (const coercion of outcome.coercions) {
            log({ level: 'info', event: 'content-coerced', component: 'C4', topicId: topic.id, moduleId: live.id, coercion });
          }
        } else {
          failures.push({ title: live.title, code: outcome.code });
          notes.push(outcome.note);
        }
        this.tick(topic.id, 'authoring', authorable.length, done, live.title);
      })(),
    );
    // WHY settled and not `Promise.all`: `all` rejects on the FIRST failure and leaves its
    // siblings running with nobody awaiting them. Nothing in the loop threw until deleting
    // a subject mid-run started throwing TopicDeletedError out of it — and then the job
    // ended while five more authoring sessions carried on writing lessons for a subject
    // that was already gone. Every task is waited for; the first real failure is re-raised
    // once they have all stopped.
    const settled = await Promise.allSettled(tasks);
    const rejected = settled.find((r) => r.status === 'rejected');
    if (rejected !== undefined && rejected.status === 'rejected') throw rejected.reason;

    const everySessionFailed = failures.length === authorable.length && authorable.length > 0;
    if (everySessionFailed) {
      // WHY: the shared cause is named exactly once instead of once per module,
      // and nothing partial is presented as complete.
      const shared = failures[0].code;
      addTopicNotes(this.deps.dataRoot, topic.id, [
        {
          kind: 'generation-failure',
          message:
            shared === 'cli-missing'
              ? NOTHING_WRITTEN_MESSAGES[0]
              : NOTHING_WRITTEN_MESSAGES[1],
          affectedModules: [],
          createdAt: nowIso(),
        },
      ]);
      setTopicStatus(this.deps.dataRoot, topic.id, 'needs-attention');
      this.tick(topic.id, 'done', authorable.length, done, null);
      return;
    }

    const capstoneNode = this.deps.store.modules.graph(topic.id).nodes.find((n) => n.kind === 'capstone');
    // WHY the content check: this used to run whenever a capstone node existed, so every
    // resume of a part-written course spent a session rewriting a brief that was already
    // finished. A written brief is done; only an unwritten one is worth a session.
    let capstoneOk = capstoneNode !== undefined && capstoneNode.content !== null;
    if (capstoneNode !== undefined && !capstoneOk && !signal.aborted) {
      this.tick(topic.id, 'capstone', authorable.length, done, capstoneNode.title);
      const capstone = await authorCapstoneSpec(
        this.deps,
        topic,
        drivingQuestion,
        this.deps.store.modules.graph(topic.id),
        capstoneNode,
        signal,
      );
      this.countSession(topic.id);
      capstoneOk = capstone.ok;
      if (!capstone.ok) notes.push(capstone.note);
    }

    // WHY (F2 AC): the discontinuity review runs once per SET OF LESSONS, after every
    // module session has settled. reviewRuns records that it has run for the lessons as
    // they stood; `done > 0` says this run changed them, so the recorded answer no longer
    // describes what is on disk. Keying it on reviewRuns alone made "once" mean once in
    // the topic's whole life: a run that recovered ten lessons after an earlier failure
    // skipped the check entirely, and the note from the failed check — the one offering to
    // run it again — could never be taken back down. A resume that writes nothing still
    // does not pay for a second review, which is what the counter was there for.
    // WHY the `stillDeferred` guard: the check reads the course as a whole, and on a course
    // written over several passes there is no whole yet — every lesson a later pass is about
    // to write comes back as a gap in the one before it. It runs on the pass that finishes
    // the course. The quoted session estimate counts it the same way, so a pass that will
    // not run it does not charge for it.
    const courseUnfinished = unwrittenModules(this.deps.store.modules.graph(topic.id)).length > 0;
    this.tick(topic.id, 'review', authorable.length, done, null);
    const state = readTopicState(this.deps.dataRoot, topic.id);
    if (!courseUnfinished && (state.reviewRuns === 0 || done > 0) && !signal.aborted) {
      dismissTopicNote(this.deps.dataRoot, topic.id, REVIEW_UNAVAILABLE_NOTE);
      // WHY the defects are no longer notes: validateGraph does not report a graph
      // problem, it FIXES one — it drops the edge that closed a loop and opens the
      // lessons nothing could reach. By the time this returns, the graph on the page is
      // the corrected graph, and a note beside it describing the broken one is an
      // account of a state the learner never saw. The record goes to the log.
      const revalidated = validateGraph(this.deps.store.modules.graph(topic.id));
      if (revalidated.validation.issues.length > 0) {
        this.deps.store.modules.upsertGraph(revalidated.graph);
        for (const issue of revalidated.validation.issues) {
          log({
            level: 'info',
            event: 'curriculum-graph-repaired',
            component: 'C4',
            topicId: topic.id,
            detail: issue.message,
            affectedModules: issue.affectedModules,
          });
        }
      }
      // WHY unconditionally, rather than only when this run rewrote something: findings
      // from before this change are still sitting on subjects generated by it, and they
      // are exactly what is no longer meant to be on the page.
      clearSupersededReviewNotes(this.deps.dataRoot, topic.id);
      await this.reviewAndRepair(topic, drivingQuestion, signal, authorable.length, done);
      const others = this.deps.store.topics.list().filter((t): t is Topic => !('degraded' in t));
      // WHY this one survives: a cross-topic candidate is not a defect in the course, it
      // is an invitation to connect it to another one (F9). Nothing is wrong with the
      // lessons, and there is something only the learner can decide.
      notes.push(...crossTopicCandidates(topic, others, this.deps.store.modules.graph(topic.id)));
      writeTopicState(this.deps.dataRoot, topic.id, {
        ...readTopicState(this.deps.dataRoot, topic.id),
        reviewRuns: 1,
      });
    }

    // WHY here and not on `status === 'ready'`: what the recovery budget is protecting
    // against is a background pass that keeps failing at the same thing. A pass that wrote
    // lessons moved the course forward, even if something else in it still needs attention,
    // so the next one is not a repeat of a fruitless attempt and should not be charged as
    // one. A pass that wrote nothing leaves the count where it is, and three of those in a
    // row end the loop.
    if (done > 0) resetPrepAttempts(this.deps.dataRoot, topic.id);

    const persisted = addTopicNotes(this.deps.dataRoot, topic.id, notes).notes;
    const status: TopicStatus =
      failures.length > 0 || !capstoneOk ? 'needs-attention' : persisted.length > 0 ? 'ready-with-notes' : 'ready';
    setTopicStatus(this.deps.dataRoot, topic.id, status);
    this.tick(topic.id, 'done', authorable.length, done, null);
    log({
      level: 'info',
      event: 'orchestrator-generation-finished',
      component: 'C4',
      topicId: topic.id,
      status,
      modulesDone: done,
      modulesDeferred: deferredCount(this.deps.store.modules.graph(topic.id)),
      sessions: this.sessionsDispatchedFor(topic.id),
    });
  }

  /**
   * WHY (F2): the consistency check is the last thing that happens to a course, and what it
   * finds used to be the last thing that happened to the learner — a list of pedagogical
   * defects filed against the person who asked to be taught. A learner cannot act on "no
   * lesson owns the Hessian"; the writer can. So a finding goes back to the lesson it names,
   * that lesson is rewritten with the finding attached, and the check runs again on the
   * result. The loop stops when the check comes back clean, when a round changes nothing,
   * or when MAX_REPAIR_ROUNDS is spent — and in the last two cases what is left goes to
   * the log, not to the page.
   */
  private async reviewAndRepair(
    topic: Topic,
    drivingQuestion: string,
    signal: AbortSignal,
    total: number,
    done: number,
  ): Promise<void> {
    // WHY the structural findings sit beside the review's: a lesson that came back as a wall
    // of text, or with no body at all, is broken in a way the reviewer is not asked about and
    // the schema deliberately does not refuse. Reading them here is what lets the loop start
    // on a course the reviewer called clean — or could not read at all.
    const structural = (): Finding[] => interleavingFindings(this.deps.store.modules.graph(topic.id));
    let findings: Finding[] = [...((await this.runReview(topic, drivingQuestion, signal)) ?? []), ...structural()];
    let rounds = 0;
    while (findings.length > 0 && rounds < MAX_REPAIR_ROUNDS && !signal.aborted) {
      rounds += 1;
      const round = await runRepairRound(
        this.deps,
        topic,
        drivingQuestion,
        this.deps.store.modules.graph(topic.id),
        findings,
        signal,
        (node) => this.tick(topic.id, 'review', total, done, node.title),
      );
      this.sessionCounts.set(topic.id, this.sessionsDispatchedFor(topic.id) + round.attempted);
      // WHY the loop stops when nothing was rewritten: the check would be shown the same
      // lessons it has already judged, so it would answer the same way, and the learner
      // would pay for a session to be told so. A round that could route no finding to a
      // written lesson is the end of what this can fix.
      if (round.repaired.length === 0) break;
      findings = [...((await this.runReview(topic, drivingQuestion, signal)) ?? []), ...structural()];
    }
    if (findings.length > 0) {
      log({
        level: 'warn',
        event: 'curriculum-repair-unresolved',
        component: 'C4',
        topicId: topic.id,
        rounds,
        remaining: findings.length,
        detail: findings.map((f) => f.message.slice(0, 300)),
      });
    }
  }

  /** `null` means the check could not tell us anything — not that it found nothing. */
  private async runReview(
    topic: Topic,
    drivingQuestion: string,
    signal: AbortSignal,
  ): Promise<Finding[] | null> {
    if (signal.aborted) return null;
    const graph = this.deps.store.modules.graph(topic.id);
    const anchor = graph.nodes.find((n) => n.content !== null) ?? graph.nodes[0];
    if (anchor === undefined) return null;
    const review = await runDiscontinuityReview(
      this.deps,
      topic,
      drivingQuestion,
      graph,
      anchor.id,
      signal,
    );
    if (review.ran) this.countSession(topic.id);
    if (!review.answered) {
      // WHY this note stays: a check that could not run is not a curriculum problem, it is
      // the app telling the learner a thing it promised to do did not happen — and the note
      // is the only place the offer to run it again lives.
      const unavailable = review.notes.filter((n) => n.message === REVIEW_UNAVAILABLE_NOTE);
      if (unavailable.length > 0) addTopicNotes(this.deps.dataRoot, topic.id, unavailable);
      return null;
    }
    return review.notes.map((n) => ({ message: n.message, affectedModules: n.affectedModules }));
  }

  private async runSingleModule(job: Job, signal: AbortSignal): Promise<void> {
    const topic = this.requireTopic(job.topicId);
    if (job.moduleId === null) throw err('validation', { detail: 'module job without a module id' });
    const graph = this.deps.store.modules.graph(topic.id);
    const node = graph.nodes.find((n) => n.id === job.moduleId);
    if (node === undefined) throw err('not-found', { detail: 'module job target missing from the graph' });
    const state = readTopicState(this.deps.dataRoot, topic.id);
    const drivingQuestion = state.drivingQuestion ?? `What does it really take to understand ${topic.subject}?`;
    // WHY: the whole-topic phases tick before every session they dispatch, but a
    // single-module job — a retry of one lesson, or a detour — ticked only once it
    // was already over. A writing session is minutes long, so the page sat on
    // whatever the last tick had said with nothing naming the lesson being written.
    // Announcing the module by name before the session starts is what makes the
    // wait legible; the counts stay the graph's, so the bar does not jump.
    const total = graph.nodes.filter((n) => n.kind !== 'capstone').length;
    const written = (): number => this.deps.store.modules.graph(topic.id).nodes.filter((n) => n.content !== null).length;
    this.tick(topic.id, 'authoring', total, written(), node.title);

    const outcome = await authorModule(
      this.deps,
      topic,
      drivingQuestion,
      graph,
      node,
      [`Understand ${node.title}.`],
      signal,
    );
    this.countSession(topic.id);
    if (!outcome.ok) {
      addTopicNotes(this.deps.dataRoot, topic.id, [outcome.note]);
      setTopicStatus(this.deps.dataRoot, topic.id, 'needs-attention');
      // WHY: 'done' is the only phase that closes the C9 stream. Throwing straight
      // out of here left the last tick reading `authoring` forever, so a failed
      // lesson looked exactly like one still being written. The note and the topic
      // status carry the failure; this only ends the wait.
      this.tick(topic.id, 'done', total, written(), node.title);
      throw err('cli-failed', { detail: `single-module job failed: ${outcome.code}`, userMessage: outcome.note.message });
    }
    const remaining = this.deps.store.modules
      .graph(topic.id)
      .nodes.filter((n) => n.kind !== 'capstone' && n.content === null);
    if (remaining.length === 0) {
      const notes = readTopicState(this.deps.dataRoot, topic.id).notes.filter((n) => n.kind !== 'generation-failure');
      writeTopicState(this.deps.dataRoot, topic.id, {
        ...readTopicState(this.deps.dataRoot, topic.id),
        notes,
        status: notes.length > 0 ? 'ready-with-notes' : 'ready',
      });
    }
    this.tick(topic.id, 'done', total, written(), node.title);
  }

  cancel(jobId: string): void {
    this.inFlight.get(jobId)?.controller.abort();
  }

  cancelAll(): void {
    for (const entry of this.inFlight.values()) entry.controller.abort();
  }

  // WHY: the owner's teardown cancels every in-flight job, awaits every retained
  // task, and clears the in-flight index so the next boot has nothing stale.
  async close(): Promise<void> {
    this.closed = true;
    this.cancelAll();
    await Promise.allSettled([...this.retained]);
    this.retained.clear();
    this.inFlight.clear();
    this.listeners.clear();
    // WHY the same guard as the finally in `runNext`: a data root that has gone
    // read-only or full must not turn a routine shutdown into an unhandled
    // rejection. The stale index is a hint that boot recovery already treats as
    // one, so failing to clear it costs nothing beyond this warning.
    try {
      writeInFlightIndex(this.deps.dataRoot, []);
    } catch (e) {
      log({
        level: 'warn',
        event: 'orchestrator-inflight-index-unwritable',
        component: 'C4',
        cause: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  return new Orchestrator(deps);
}
