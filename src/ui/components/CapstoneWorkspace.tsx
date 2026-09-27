// FRACTAL: implements F13 | component C10
'use client';
import { useMemo, type ReactNode } from 'react';
import type {
  ApiResponse,
  EntryDecision,
  EvalSession,
  EvalTurnResult,
  ModuleNode,
  Reflection,
  Topic,
} from '@/shapes';
import { ChatPanel } from '@/ui/components/ChatPanel';
import { MathText } from '@/ui/components/MathText';
import { continueEvaluation } from '@/ui/api-client';
import { renderMarkdown } from '@/ui/sanitize';
import {
  advisoryNote,
  advisorySentence,
  unmetPrereqTitles,
  useOptimisticView,
} from '@/ui/lesson';

export type CapstoneWorkspaceProps = {
  topic: Topic;
  node: ModuleNode | null;
  session: EvalSession;
  entry: EntryDecision;
  saveNote: (text: string) => Promise<ApiResponse<Reflection>>;
  submit: (artifact: string) => Promise<ApiResponse<EvalTurnResult>>;
  onResult: (result: EvalTurnResult) => void;
};

export type CapstoneBriefProps = { topic: Topic; node: ModuleNode | null };

/**
 * The whole assignment in one place. It is shown before the review is opened as well as
 * inside it, so nobody has to start a review to find out what they were asked to build.
 */
export function CapstoneBrief({ topic, node }: CapstoneBriefProps): ReactNode {
  // The written brief is kept as the final project's explanation text, and is marked up
  // here the same way lesson explanations are.
  const spec =
    node !== null && node.content !== null && node.content.explanation.kind === 'text'
      ? node.content.explanation.markdown
      : null;
  const html = useMemo(() => (spec === null ? null : renderMarkdown(spec)), [spec]);

  return (
    <section className="la-card" data-testid="capstone-brief">
      <h3>What you are building</h3>
      {html === null ? null : (
        <div className="la-prose" data-testid="capstone-spec" dangerouslySetInnerHTML={{ __html: html }} />
      )}
      <p data-testid="capstone-driving-question">
        The question behind this subject:{' '}
        {topic.drivingQuestion === null ? (
          <>
            Making real use of <MathText text={topic.subject} />.
          </>
        ) : (
          <MathText text={topic.drivingQuestion} />
        )}
      </p>
      <p data-testid="capstone-purpose">
        {topic.purpose.length === 0
          ? 'The brief above is the project: it answers the question behind this subject.'
          : `Why you took this on: ${topic.purpose}`}
      </p>
      <p className="la-muted">
        Hand in the thing itself, or a full description of it — enough that someone could build it
        from your words. You will get specific comments back and can hand in an improved version as
        many times as you like.
      </p>
    </section>
  );
}

export function CapstoneWorkspace({
  topic,
  node,
  session,
  entry,
  saveNote,
  submit,
  onResult,
}: CapstoneWorkspaceProps): ReactNode {
  const missing = unmetPrereqTitles(entry);
  const view = useOptimisticView<{ acknowledged: boolean }>({ acknowledged: missing.length === 0 });

  const acknowledge = (): void => {
    view.run<Reflection>({
      kind: 'save-reflection',
      apply: () => ({ acknowledged: true }),
      persist: () => saveNote(advisoryNote(missing)),
      reconcile: (state) => state,
    });
  };

  return (
    <article data-testid="capstone-workspace">
      <h1>
        {node === null ? 'Your final project' : <MathText text={node.title} />}
      </h1>
      <CapstoneBrief topic={topic} node={node} />

      {view.state.acknowledged ? null : (
        <section className="la-warn" role="alert" data-testid="capstone-advisory">
          <p data-testid="capstone-advisory-text">{advisorySentence(missing)}</p>
          <button type="button" data-testid="acknowledge-capstone-advisory" onClick={acknowledge}>
            Got it — start anyway
          </button>
        </section>
      )}
      {view.error === null ? null : (
        <p className="la-error" role="alert" data-testid="capstone-error">
          {view.error}
        </p>
      )}

      {view.state.acknowledged ? (
        <ChatPanel
          draftKey={`capstone-draft:${topic.id}`}
          turns={session.turns}
          composerLabel="Describe what you built, and why you made the choices you did"
          sendLabel="Hand it in"
          emptyMessage="Nothing handed in yet. Everything you send stays here, round after round."
          persist={(message) => submit(message.text)}
          // WHY: a review interrupted after the hand-in was saved owes a verdict, and
          // reopening the workspace is where that gets asked for. Same rule as the lesson
          // conversation — the artefact is the message.
          resume={() => continueEvaluation(session.id)}
          onResult={onResult}
        />
      ) : null}
    </article>
  );
}
