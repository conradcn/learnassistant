// FRACTAL: implements F13 | component C10
'use client';
import Link from 'next/link';
import { use, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  ApiResponse,
  EntryDecision,
  EvalSession,
  EvalTurnResult,
  Topic,
  TopicId,
} from '@/shapes';
import { topicIdSchema } from '@/shapes';
import {
  getModule,
  getTopic,
  openEvaluation,
  resumeEvaluation,
  saveReflection,
  submitCapstone,
} from '@/ui/api-client';
import { fromResponse, LOADING, type LoadState } from '@/ui/load-state';
import { LoadStateBoundary } from '@/ui/components/LoadStateBoundary';
import { CapstoneBrief, CapstoneWorkspace } from '@/ui/components/CapstoneWorkspace';
import { capstoneNode } from '@/ui/graph-layout';
import { useStartWork } from '@/ui/lesson';

const BAD_LINK = 'That link does not point at anything we can open.';
const COULD_NOT_START = 'We could not start that review. Try handing your work in again.';
const NO_ENTRY: EntryDecision = { enterable: true, advisory: null };

type CapstoneView = {
  topic: Topic;
  node: ReturnType<typeof capstoneNode>;
  entry: EntryDecision;
};

function verdictLine(result: EvalTurnResult): string {
  if (result.verdict.outcome === 'pass' || result.verdict.outcome === 'assisted-pass') {
    return 'Your project passed. That finishes this subject off.';
  }
  return 'Have a read of the comments above, improve it, and hand it in again.';
}

export default function CapstonePage({ params }: { params: Promise<{ id: string }> }): ReactNode {
  const raw = use(params).id;
  const parsed = topicIdSchema.safeParse(raw);
  const topicId: TopicId | null = parsed.success ? parsed.data : null;

  const [state, setState] = useState<LoadState<CapstoneView>>(LOADING);
  const [session, setSession] = useState<EvalSession | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const work = useStartWork();
  /**
   * WHY (H2): same reason as the eval page — the press lands a tick before `opening` goes
   * up, and the review invitation must not come back (nor its button go live again) inside
   * that window.
   */
  const busy = opening || work.awaiting;

  const load = useCallback((): void => {
    if (topicId === null) {
      setState({ status: 'error', error: { code: 'validation', message: BAD_LINK, correlationId: 'c_browser' } });
      return;
    }
    setState(LOADING);
    void getTopic(topicId).then((response) => {
      if (!response.ok) {
        setState({ status: 'error', error: response.error });
        return;
      }
      const detail = response.data;
      if ('degraded' in detail.topic) {
        setState({
          status: 'error',
          error: {
            code: 'store-corrupt',
            message: 'We could not read this subject, so its final project is out of reach for now.',
            correlationId: 'c_browser',
          },
        });
        return;
      }
      const node = capstoneNode(detail.graph);
      if (node === null) {
        setState({ status: 'empty' });
        return;
      }
      const topic = detail.topic;
      void getModule(node.id).then((moduleResponse) => {
        setState(
          fromResponse<CapstoneView>(
            moduleResponse.ok
              ? { ok: true, data: { topic, node, entry: moduleResponse.data.entry } }
              : { ok: true, data: { topic, node, entry: NO_ENTRY } },
            () => false,
          ),
        );
      });
    });
  }, [topicId]);

  useEffect(load, [load]);

  // WHY (F13): a hand-in conversation is long-lived — the learner goes away, builds, and
  // comes back. Restoring it is a pure read of what is already stored, so it happens on
  // load; only opening a review that does not exist yet costs anything.
  const resumed = useRef(false);
  useEffect(() => {
    if (topicId === null || session !== null || resumed.current) return;
    resumed.current = true;
    void resumeEvaluation({ kind: 'capstone', topicId }).then((response) => {
      if (response.ok && response.data !== null) setSession(response.data);
    });
  }, [topicId, session]);

  const begin = (): void => {
    if (topicId === null) return;
    setMessage(null);
    work.run(() => {
      // WHY (H2): opening the review is a real session and it can take a while to come
      // back. Without a flag held from the press until the reply settles, the page looks
      // untouched and the same start is offered again.
      setOpening(true);
      return openEvaluation({ kind: 'capstone', topicId }).then((response) => {
        setOpening(false);
        if (response.ok) {
          setSession(response.data);
          return;
        }
        setMessage(response.error.message);
      });
    });
  };

  /**
   * Hands the project in.
   *
   * WHY nothing stands in front of it: each hand-in is its own Claude CLI session, and the
   * learner pressing hand-in is the whole authorisation.
   */
  const submit = (artifact: string): Promise<ApiResponse<EvalTurnResult>> => {
    if (topicId === null) {
      return Promise.resolve({
        ok: false,
        error: { code: 'validation', message: COULD_NOT_START, correlationId: 'c_browser' },
      });
    }
    setMessage(null);
    return submitCapstone(topicId, artifact);
  };

  return (
    <>
      <LoadStateBoundary
      state={state}
      label="your final project"
      emptyMessage="This subject does not have a final project."
      onRetry={load}
    >
      {(view): ReactNode => (
        <>
          <p className="la-row">
            <Link href={`/topics/${view.topic.id}`}>Back to the whole subject</Link>
          </p>
          {session === null ? (
            <>
              <h1>{view.node === null ? 'Your final project' : view.node.title}</h1>
              <CapstoneBrief topic={view.topic} node={view.node} />
              <section className="la-card" data-testid="capstone-start">
                {busy ? (
                  <p className="la-muted" role="status" data-testid="capstone-opening">
                    Opening the conversation about your project. This takes a moment.
                  </p>
                ) : (
                  <p>
                    When you are ready to show what you have built, we will open a conversation about it
                    and give you specific comments. You can improve it and hand it in as often as you like.
                  </p>
                )}
                <button
                  type="button"
                  className="la-primary"
                  data-testid="open-capstone"
                  disabled={busy}
                  aria-busy={busy}
                  onClick={begin}
                >
                  {busy ? 'Starting…' : 'Start the project review…'}
                </button>
              </section>
            </>
          ) : (
            <CapstoneWorkspace
              topic={view.topic}
              node={view.node}
              session={session}
              entry={view.entry}
              saveNote={(text) =>
                saveReflection({
                  topicId: view.topic.id,
                  moduleId: view.node === null ? null : view.node.id,
                  text,
                })
              }
              submit={submit}
              onResult={(result) => {
                setSession(result.session);
                setVerdict(verdictLine(result));
              }}
            />
          )}
          {verdict === null ? null : <p data-testid="capstone-verdict">{verdict}</p>}
          {message === null && work.error === null ? null : (
            <p className="la-error" role="alert" data-testid="capstone-message">
              {message ?? work.error}
            </p>
          )}
        </>
      )}
      </LoadStateBoundary>
    </>
  );
}
