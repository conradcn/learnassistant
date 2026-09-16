// FRACTAL: implements F3, F5, F12, F13 | component C10
'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { GenerationProgress, ModuleId, ProviderView, TopicId, TopicStatus } from '@/shapes';
import { moduleIdSchema, topicIdSchema } from '@/shapes';
import type { TopicDetailView } from '@/ui/shapes';
import {
  deleteTopic,
  getProvider,
  getTopic,
  requestDetour,
  requestExtension,
  startGeneration,
  subscribeProgress,
} from '@/ui/api-client';
import { fromResponse, LOADING, type LoadState } from '@/ui/load-state';
import { LoadStateBoundary } from '@/ui/components/LoadStateBoundary';
import { GraphView } from '@/ui/components/GraphView';
import { MathText } from '@/ui/components/MathText';
import { capstoneNode } from '@/ui/graph-layout';
import { useStartWork } from '@/ui/lesson';
import {
  extensionLine,
  generationFailed,
  planStep,
  planningExtension,
  planningPanel,
  writingMore,
} from '@/ui/plan-card';
import { prepWindow } from '@/orchestrator/prep-window';
import { setTopic } from '@/ui/store';

const BAD_LINK = 'That link does not point at anything we can open.';

/** The reassurance the "Write the lessons" button leaves on screen while the run is live. */
const WRITING_MESSAGE = 'We are writing your lessons now. They will appear here as they land.';

/**
 * How often the page refetches the subject for as long as a run is under way.
 *
 * WHY this runs even while the stream is healthy, rather than only after it drops: a tick
 * is emitted when a phase STARTS, and the endings do not all tick. A research pass that
 * fails writes the failure and hands the subject back without another word down the
 * socket, so a page waiting on the stream alone would sit on "Planning your lessons…"
 * next to a run that had already died — the exact bug this file exists to fix, wearing a
 * different hat. Sockets also simply end: the server caps a stream at an hour, a proxy
 * cuts an idle one, a laptop sleeps. The stream is what makes this page feel live; the
 * poll is what makes it true.
 */
const POLL_MS = 5_000;

/** WHY nothing is said before a total is known: "0 of 0" is a worse answer than silence. */
function writtenSoFar(progress: GenerationProgress | null): string | null {
  if (progress === null || progress.modulesTotal === 0) return null;
  const { modulesDone, modulesTotal } = progress;
  return `${modulesDone} of ${modulesTotal} lesson${modulesTotal === 1 ? '' : 's'} written so far.`;
}

/* WHY (F2): the same words the dashboard card uses, so arriving here after "Work has started"
   confirms the state the learner already read rather than describing it a second way. */
/** Shown in place of the stored status for as long as the planning panel is up. */
const PLANNING_STATUS_TEXT = 'Planning now';

const STATUS_TEXT: Record<TopicStatus, string> = {
  queued: 'Planning soon',
  generating: 'Writing now',
  ready: 'Ready',
  'ready-with-notes': 'Ready · a few notes',
  'needs-attention': 'Needs a look',
  'modules-complete': 'Project left',
  done: 'Finished',
};


/** WHY the file name and not the path: a .gguf sits behind a long path, and a badge is
 *  read at a glance or not at all. */
function plannerReady(provider: ProviderView): string {
  const name = provider.model.trim();
  if (name.length === 0) return 'AI ready';
  return `${name.split(/[\/]/).pop() ?? name} ready`;
}

export default function TopicPage({ params }: { params: Promise<{ id: string }> }): ReactNode {
  const raw = use(params).id;
  const parsed = topicIdSchema.safeParse(raw);
  const topicId: TopicId | null = parsed.success ? parsed.data : null;

  const [state, setState] = useState<LoadState<TopicDetailView>>(LOADING);
  const [anchor, setAnchor] = useState('');
  const [question, setQuestion] = useState('');
  const [goal, setGoal] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  // WHY these two refs and the effect below: asking to delete swaps the button the
  // learner just pressed for a pair of buttons, so React unmounts the focused node and
  // the browser drops focus onto <body>. On a page this long that put a keyboard user
  // back above the nav, several dozen Tab presses from the confirmation they had just
  // asked for, and said nothing about why. Focus follows the swap in both directions.
  const confirmRemoveRef = useRef<HTMLButtonElement>(null);
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  // Whether the confirmation was up on the previous render, so that first paint — where
  // nothing was focused and nothing changed — does not steal focus to the delete button.
  const wasConfirming = useRef(false);
  // WHY (F2): the counts the run reports as it goes. They are held apart from the topic
  // itself because they arrive far more often than the stored graph changes, and the
  // graph is what the rest of this page is drawn from.
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  // Whether the live stream has ended while the run is still going, which is what puts
  // the polled refetch below in charge.
  const [streamDown, setStreamDown] = useState(false);
  const work = useStartWork();
  const router = useRouter();
  // WHY the planning card asks the provider whether it can answer: pressing "Plan the
  // lessons" hands the work to a model that may not be running, and until now the only
  // way to find that out was to press and wait for the failure. `null` means the probe
  // has not come back yet, and a status nobody has yet is one this card does not show.
  const [planner, setPlanner] = useState<ProviderView | null>(null);

  const load = useCallback((): void => {
    if (topicId === null) {
      setState({ status: 'error', error: { code: 'validation', message: BAD_LINK, correlationId: 'c_browser' } });
      return;
    }
    setState(LOADING);
    void getTopic(topicId).then((response) => {
      setState(fromResponse(response, () => false));
      setTopic(response.ok ? { graph: response.data.graph, availability: response.data.availability } : null);
    });
  }, [topicId]);

  useEffect(load, [load]);

  /**
   * A refetch that leaves the screen alone while it runs.
   *
   * WHY this is not `load`: `load` drops back to LOADING first, which tears the whole
   * subject down to a spinner. Doing that once a minute for the length of a generation
   * would be worse than the frozen page it replaces — the learner would lose the lessons
   * they were reading every time another one landed.
   */
  const refresh = useCallback((): void => {
    if (topicId === null) return;
    void getTopic(topicId).then((response) => {
      if (!response.ok) return;
      setState(fromResponse(response, () => false));
      setTopic({ graph: response.data.graph, availability: response.data.availability });
    });
  }, [topicId]);

  const loaded = state.status === 'ready' ? state.data : null;
  const topicStatus: TopicStatus | null =
    loaded !== null && !('degraded' in loaded.topic) ? loaded.topic.status : null;
  /** A run is under way, so there is something for the stream to report. */
  const running = topicStatus === 'queued' || topicStatus === 'generating';

  // WHY a ref and not state: a tick that repeats the counts it last carried (a heartbeat
  // after a phase change, the opening tick the stream always replays on connect) is not
  // news, and refetching the whole subject for it would put a request on the wire for
  // every keep-alive.
  const lastTick = useRef('');

  useEffect(() => {
    if (topicId === null || !running) return undefined;
    setStreamDown(false);
    // Counts belong to one run. Carrying the last run's into this one would show a course
    // as most-of-the-way written a second before the first lesson of it exists.
    setProgress(null);
    return subscribeProgress(topicId, {
      onProgress: (next): void => {
        setProgress(next);
        const mark = `${next.phase}:${next.modulesDone}:${next.modulesTotal}`;
        if (mark === lastTick.current) return;
        lastTick.current = mark;
        // The tick carries counts, not lessons. The graph the page draws comes from the
        // store, so a lesson landing is only on screen once the subject is read again.
        refresh();
      },
      onError: (): void => setStreamDown(true),
      onClose: (): void => setStreamDown(true),
    });
  }, [topicId, running, refresh]);

  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(refresh, POLL_MS);
    return (): void => clearInterval(timer);
  }, [running, refresh]);

  // WHY derived and not cleared in an effect: "We are writing your lessons now" is true
  // for exactly as long as the run is, and an effect would have to catch the moment it
  // stopped — including the case where the run dies before the first refetch even lands,
  // where there is no moment to catch. Read off the status, the sentence simply cannot
  // outlive the work it describes. Left standing, it was the single line that made a
  // crashed job read as a live one.
  const notice = message === WRITING_MESSAGE && !running ? null : message;

  useEffect(() => {
    void getProvider().then((response) => {
      if (response.ok) setPlanner(response.data);
    });
  }, []);

  const askForDetour = (event: FormEvent<HTMLFormElement>, anchorId: ModuleId): void => {
    event.preventDefault();
    if (topicId === null) return;
    const text = question.trim();
    if (text.length === 0) {
      setMessage('Say what you would like to go into more deeply.');
      return;
    }
    setMessage(null);
    work.run(() => {
      return requestDetour(topicId, anchorId, text).then((response) => {
        if (response.ok) {
          setQuestion('');
          setMessage('We are writing that extra lesson now. It will appear here when it is ready.');
          return;
        }
        setMessage(response.error.message);
      });
    });
  };

  // WHY (F12) this is a separate press from the detour beside it: a detour is one lesson
  // hung off the lesson the learner is in; this re-plans the course to somewhere further —
  // "Practical Biology" carried to "sufficient knowledge for the MCAT" — and what comes back
  // is a batch of new lessons in the plan, which the button below then writes.
  const askToExtend = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (topicId === null) return;
    const text = goal.trim();
    if (text.length === 0) {
      setMessage('Say where you would like this subject to take you.');
      return;
    }
    setMessage(null);
    work.run(() => {
      return requestExtension(topicId, text).then((response) => {
        if (response.ok) {
          setGoal('');
          setMessage(
            'We are working out the extra lessons for that. They will appear in the plan when it lands.',
          );
          load();
          return;
        }
        setMessage(response.error.message);
      });
    });
  };

  // WHY (F2): planning a subject is two steps, not one. The first writes the outline; the
  // sessions that write the lessons can only start once that outline exists, so they need
  // their own press. Until this button existed the second step had no door anywhere in the
  // app — the outline landed and the subject simply stopped, with no lessons and nothing
  // to press.
  const writeLessons = (): void => {
    if (topicId === null) return;
    setMessage(null);
    work.run(() => {
      return startGeneration(topicId).then((response) => {
        if (response.ok) {
          setMessage(WRITING_MESSAGE);
          load();
          return;
        }
        setMessage(response.error.message);
      });
    });
  };

  // WHY: deleting takes the lessons, the final project and every reflection with it, and
  // nothing here can be written back afterwards — so the press that does it is never the
  // first press. Until now this door only existed on subjects that had already broken.
  useEffect(() => {
    if (confirmingRemove) confirmRemoveRef.current?.focus();
    else if (wasConfirming.current) removeButtonRef.current?.focus();
    wasConfirming.current = confirmingRemove;
  }, [confirmingRemove]);

  const remove = (): void => {
    if (topicId === null) return;
    setMessage(null);
    void deleteTopic(topicId).then((response) => {
      if (!response.ok) {
        setConfirmingRemove(false);
        setMessage(response.error.message);
        return;
      }
      setMessage('That subject has been removed.');
      router.push('/');
      router.refresh();
    });
  };

  return (
    <>
      <p className="la-row">
        <Link href="/">← All subjects</Link>
      </p>
      <LoadStateBoundary
        state={state}
        label="this subject"
        emptyMessage="There is nothing in this subject yet."
        onRetry={load}
      >
        {(view): ReactNode => {
          if ('degraded' in view.topic) {
            return (
              <section className="la-card la-degraded" role="alert" data-testid="degraded-topic">
                <h1>We couldn&apos;t read this subject</h1>
                <p>{view.topic.reason}</p>
                <button type="button" data-testid="remove-topic" onClick={remove}>
                  Remove it and start again
                </button>
              </section>
            );
          }
          const capstone = capstoneNode(view.graph);
          const anchorChoices = view.graph.nodes.filter((node) => node.kind !== 'capstone');
          // The lessons the plan names but nobody has written yet — the capstone has its
          // own page and its own action, so it is not counted here.
          const unwritten = anchorChoices.filter((node) => node.content === null).length;
          // What pressing the button actually writes: the lessons nearest the front of the
          // prerequisite graph, which is what C4 will run.
          const nextBatch = prepWindow(view.graph).length;
          const step = planStep(view.topic.status, view.graph, unwritten);
          const anchorId = moduleIdSchema.safeParse(anchor);
          const failed = generationFailed(view.topic.status, view.topic.notes);
          const written = writtenSoFar(progress);
          return (
            <>
              <h1 className="la-header">
                <MathText text={view.topic.subject} />
                {/* WHY: while the planning panel is on screen it already says, in a whole
                    sentence, that the lessons are being written. The stored status can still
                    be `queued` at that moment, so the pill read "waiting to be planned" right
                    above "We are planning your lessons" — two answers to one question, on the
                    step straight after the learner authorised the run. */}
                <span className="la-badge" data-testid="topic-status">
                  {planningPanel(view.topic.status, view.graph)
                    ? PLANNING_STATUS_TEXT
                    : STATUS_TEXT[view.topic.status]}
                </span>
              </h1>
              {view.topic.drivingQuestion === null ? null : (
                <MathText
                  as="p"
                  className="la-driving-question"
                  testId="driving-question"
                  text={view.topic.drivingQuestion}
                />
              )}
              {/* WHY (F2) a card of its own and not one more line in the warnings list: for
                  the length of a run this page said "We are writing your lessons now", and
                  when the run died it went on saying it. A stopped run and a running one
                  looked the same, so the learner's only move was to wait for something that
                  was never coming. This is the ending said out loud, in the colour of a
                  failure, with the notes that explain it and the door back in. */}
              {failed ? (
                <section className="la-card la-degraded" role="alert" data-testid="topic-generation-failed">
                  <h2>That run stopped before it finished</h2>
                  <ul data-testid="topic-notes">
                    {view.topic.notes.map((note) => (
                      <li key={`${note.kind}-${note.createdAt}`}>{note.message}</li>
                    ))}
                  </ul>
                  <p className="la-muted">
                    Nothing you already have was lost. Starting it again picks up from what is
                    written.
                  </p>
                </section>
              ) : view.topic.notes.length === 0 ? null : (
                <ul className="la-warn" data-testid="topic-notes">
                  {view.topic.notes.map((note) => (
                    <li key={`${note.kind}-${note.createdAt}`}>{note.message}</li>
                  ))}
                </ul>
              )}

              {/* WHY (F2): while the plan is still being written there is nothing to pick, and an
                  empty lesson list reads as failure rather than as work in progress. */}
              {planningPanel(view.topic.status, view.graph) ? (
                <section className="la-card" data-testid="topic-planning">
                  <h2>Planning your lessons…</h2>
                  {/* WHY the live region is this sentence and not the whole card: a
                      generation ticks over every lesson it writes, and with `role="status"`
                      on the section a screen reader read the count out again on every one of
                      them — a run of thirty lessons became thirty interruptions. The
                      reassurance is what is worth announcing, and it is said once. The count
                      below is ordinary text: on the page, readable at any time, and silent
                      as it climbs. */}
                  <p className="la-muted" role="status">
                    This takes a few minutes. Feel free to leave — they&apos;ll be here when you
                    get back.
                  </p>
                  {written === null ? null : <p data-testid="topic-progress">{written}</p>}
                  {streamDown ? (
                    <p className="la-muted" data-testid="topic-progress-polling">
                      Live updates dropped out, so we&apos;re checking again every few seconds.
                    </p>
                  ) : null}
                </section>
              ) : (
                <>
                  {/* WHY beside the graph rather than instead of it: the pass that writes the
                      next few lessons was sold as "you can start while the rest wait", and
                      replacing the graph took away the lessons the learner was invited to
                      start. */}
                  {writingMore(view.topic.status, view.graph) ? (
                    <section className="la-card" data-testid="topic-writing-more">
                      <h2>
                        {planningExtension(view.extensions)
                          ? 'Working out the extra lessons…'
                          : 'Writing more lessons…'}
                      </h2>
                      {/* The live region is the sentence, not the card — see the note on the
                          planning panel for why the count is deliberately not announced. */}
                      <p className="la-muted" role="status">
                        {planningExtension(view.extensions)
                          ? 'They will appear in the plan when it lands. Everything already here is yours to read in the meantime.'
                          : "They'll appear below as they land. Everything already here is yours to read in the meantime."}
                      </p>
                      {written === null ? null : <p data-testid="topic-progress">{written}</p>}
                      {streamDown ? (
                        <p className="la-muted" data-testid="topic-progress-polling">
                          Live updates dropped out, so we&apos;re checking again every few
                          seconds.
                        </p>
                      ) : null}
                    </section>
                  ) : null}
                  <GraphView graph={view.graph} availability={view.availability} />
                </>
              )}

              {step === null ? null : (
                <section className="la-card" data-testid="write-lessons-card">
                  <h2 className="la-header">
                    {step === 'plan' ? 'Plan the lessons' : 'Write the lessons'}
                    {/* WHY the model's name rather than a bare tick: with a separate chat
                        model configured, "Ready" alone does not say WHICH one is about to
                        be handed the lessons. */}
                    {planner === null ? null : (
                      <span
                        className={planner.available ? 'la-badge' : 'la-badge la-error'}
                        data-testid="planner-status"
                      >
                        {planner.available ? plannerReady(planner) : 'AI not answering'}
                      </span>
                    )}
                  </h2>
                  <p className="la-muted">
                    {step === 'plan'
                      ? 'Nothing planned yet. Pressing the button starts it.'
                      : nextBatch === unwritten
                        ? `${unwritten} lesson${unwritten === 1 ? '' : 's'} still to write. Pressing the button starts them.`
                        : /* WHY the two numbers: a long course is written a few lessons at a
                             time (C4/prep-window), so "26 still to write" beside a button that
                             writes 10 would misdescribe what pressing it does. */
                          `${unwritten} lessons still to write. This writes the next ${nextBatch}, so you can start while the rest wait.`}
                  </p>
                  {/* The button says the same thing as the heading above it: on this step the
                      work it starts is planning the lessons, not writing them. */}
                  <button type="button" data-testid="write-lessons" onClick={writeLessons} disabled={work.awaiting}>
                    {work.awaiting ? 'Starting…' : step === 'plan' ? 'Plan the lessons' : 'Write the lessons'}
                  </button>
                </section>
              )}

              {capstone === null ? null : (
                <p className="la-row">
                  <Link href={`/topics/${view.topic.id}/capstone`} data-testid="capstone-link">
                    {/* The node's own title already begins "Project: …", so the link says
                        where it goes without printing the word twice. */}
                    Final project: <MathText text={capstone.title.replace(/^Project:\s*/, '')} /> →
                  </Link>
                </p>
              )}

              {anchorChoices.length === 0 ? null : (
                <form
                  className="la-card"
                  data-testid="detour-form"
                  onSubmit={(event) => {
                    if (!anchorId.success) {
                      event.preventDefault();
                      setMessage('Pick which lesson your question came out of.');
                      return;
                    }
                    askForDetour(event, anchorId.data);
                  }}
                >
                  <h2>Want to go deeper?</h2>
                  <label htmlFor="detour-anchor">Coming out of which lesson?</label>
                  <select
                    id="detour-anchor"
                    data-testid="detour-anchor"
                    value={anchor}
                    onChange={(event) => setAnchor(event.target.value)}
                  >
                    <option value="">Choose a lesson</option>
                    {anchorChoices.map((node) => (
                      <option key={node.id} value={node.id}>
                        {node.title}
                      </option>
                    ))}
                  </select>
                  <label htmlFor="detour-question">What would you like to dig into?</label>
                  <textarea
                    id="detour-question"
                    data-testid="detour-question"
                    rows={3}
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                  />
                  {/* WHY (H2): the question stays in the box until the request settles, so
                      without this the learner is left looking at a filled-in form and a live
                      button while the extra lesson they just paid for is already being
                      written — and a second press buys a second real Claude session. */}
                  <button type="submit" data-testid="request-detour" disabled={work.awaiting}>
                    {work.awaiting ? 'Asking…' : 'Ask for an extra lesson'}
                  </button>
                </form>
              )}

              {/* WHY it is not offered while the outline is still being written: there is no
                  course to extend yet, and the request would be refused by C4 anyway — an
                  offer that cannot be taken is worse than no offer. */}
              {view.graph.nodes.length === 0 ? null : (
                <form className="la-card" data-testid="extend-form" onSubmit={askToExtend}>
                  <h2>Take this subject further</h2>
                  <p className="la-muted">
                    Say where you want to get to and we plan the extra lessons that get you
                    there — on top of what is already here, without repeating it.
                  </p>
                  {view.extensions.length === 0 ? null : (
                    <ul className="la-muted" data-testid="topic-extensions">
                      {view.extensions.map((extension) => (
                        <li key={`${extension.createdAt}-${extension.goal}`}>
                          {extensionLine(extension)}
                        </li>
                      ))}
                    </ul>
                  )}
                  <label htmlFor="extend-goal">Where would you like to get to?</label>
                  <textarea
                    id="extend-goal"
                    data-testid="extend-goal"
                    rows={2}
                    placeholder="Sufficient knowledge for the MCAT"
                    value={goal}
                    onChange={(event) => setGoal(event.target.value)}
                  />
                  {/* Same reason as the detour button: a second press while the first is in
                      flight buys a second real planning session. */}
                  <button type="submit" data-testid="request-extension" disabled={work.awaiting}>
                    {work.awaiting ? 'Asking…' : 'Extend this subject'}
                  </button>
                </form>
              )}

              <section className="la-card" data-testid="remove-topic-card">
                <h2>Remove this subject</h2>
                <p className="la-muted">
                  Deletes {view.topic.subject}, its lessons and your notes. This can&apos;t be
                  undone.
                </p>
                {confirmingRemove ? (
                  <p className="la-row">
                    <button ref={confirmRemoveRef} type="button" data-testid="confirm-remove-topic" onClick={remove}>
                      Yes, delete it
                    </button>
                    <button type="button" data-testid="cancel-remove-topic" onClick={() => setConfirmingRemove(false)}>
                      Keep it
                    </button>
                  </p>
                ) : (
                  <button
                    ref={removeButtonRef}
                    type="button"
                    data-testid="remove-topic"
                    onClick={() => setConfirmingRemove(true)}
                  >
                    Delete this subject
                  </button>
                )}
              </section>
            </>
          );
        }}
      </LoadStateBoundary>

      {/* WHY (F12): a request that went through and a request that failed cannot share one
          colour — the reassurance after asking for a detour was rendered in the failure red. */}
      {/* WHY (H2): between the learner asking and the server answering there was nothing on
          screen at all — the form still held their question and no notice had been written
          yet, so a live detour looked like a click that did nothing. */}
      {work.awaiting ? (
        <p className="la-notice" role="status" data-testid="topic-message">
          Starting that now…
        </p>
      ) : notice !== null ? (
        <p className="la-notice" role="status" data-testid="topic-message">
          {notice}
        </p>
      ) : work.error === null ? null : (
        <p className="la-error" role="alert" data-testid="topic-message">
          {work.error}
        </p>
      )}
    </>
  );
}
