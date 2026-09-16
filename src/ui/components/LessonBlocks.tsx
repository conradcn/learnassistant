// FRACTAL: implements F3 | component C10
'use client';
import { useMemo, useState, type ReactNode } from 'react';
import type { LessonBlock } from '@/shapes';
import { renderMarkdown, sanitizeSvg } from '@/ui/sanitize';
import { MathText } from '@/ui/components/MathText';
import {
  blockKey,
  checkFeedback,
  correctOption,
  stepAt,
  stepProgress,
  type CheckBlock,
  type StepsBlock,
} from '@/ui/blocks';

/** Model markdown, escaped and re-marked-up by C10's own renderer — never trusted as markup. */
function Prose({ markdown }: { markdown: string }): ReactNode {
  const html = useMemo(() => renderMarkdown(markdown), [markdown]);
  return <div className="la-prose" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Figure({ svg, caption }: { svg: string; caption: string }): ReactNode {
  const safe = useMemo(() => sanitizeSvg(svg), [svg]);
  return (
    <figure className="la-figure" data-testid="block-figure">
      <div dangerouslySetInnerHTML={{ __html: safe }} />
      <MathText as="figcaption" className="la-muted" text={caption} />
    </figure>
  );
}

function TableFigure({
  block,
}: {
  block: Extract<LessonBlock, { kind: 'table' }>;
}): ReactNode {
  return (
    <figure className="la-figure" data-testid="block-table">
      <table>
        <thead>
          <tr>
            {block.headers.map((header) => (
              <th key={header} scope="col">
                <MathText text={header} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={`row-${rowIndex}-${row.join('|')}`}>
              {row.map((cell, cellIndex) => (
                <td key={`cell-${cellIndex}-${cell}`}>
                  <MathText text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <MathText as="figcaption" className="la-muted" text={block.caption} />
    </figure>
  );
}

/**
 * WHY the options stay live after an answer: the point is to think, and a control that locks
 * on first touch punishes a misclick by ending the thinking. Changing the pick simply moves
 * the feedback, and there is nothing recorded for a second attempt to contaminate.
 */
function Check({ block }: { block: CheckBlock }): ReactNode {
  const [selected, setSelected] = useState<number | null>(null);
  const feedback = checkFeedback(block, selected);
  return (
    <section className="la-check" data-testid="block-check">
      <MathText as="p" className="la-check-q" text={block.question} testId="check-question" />
      <ul className="la-check-options">
        {block.options.map((option, index) => (
          <li key={`${index}-${option}`}>
            <button
              type="button"
              aria-pressed={selected === index}
              className={selected === index ? 'la-check-picked' : undefined}
              data-testid={`check-option-${index}`}
              onClick={() => setSelected(index)}
            >
              <MathText text={option} />
            </button>
          </li>
        ))}
      </ul>
      {feedback === null ? (
        <p className="la-muted">Pick one before you read on — nothing is recorded either way.</p>
      ) : (
        <div
          className={feedback.correct ? 'la-check-right' : 'la-check-wrong'}
          role="status"
          data-testid="check-feedback"
        >
          <p>{feedback.correct ? 'That is the one.' : 'Not that one.'}</p>
          <MathText as="p" text={feedback.text} />
          {feedback.correct ? null : (
            <p>
              The answer is <MathText text={correctOption(block)} />.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** Try-before-you-look: the answer is in the page, but only after the learner asks for it. */
function Reveal({ block }: { block: Extract<LessonBlock, { kind: 'reveal' }> }): ReactNode {
  const [shown, setShown] = useState(false);
  return (
    <section className="la-reveal" data-testid="block-reveal">
      <MathText as="p" text={block.prompt} testId="reveal-prompt" />
      {shown ? (
        <div className="la-reveal-answer" data-testid="reveal-answer">
          <Prose markdown={block.answer} />
        </div>
      ) : (
        <button type="button" data-testid="reveal-show" onClick={() => setShown(true)}>
          Have a go, then show me
        </button>
      )}
    </section>
  );
}

/**
 * A derivation the learner advances a line at a time. WHY not simply print all of it: the
 * same eight lines printed at once are skimmed as a block; printed one at a time each line
 * costs a deliberate click, which is the whole difference between reading and following.
 */
function Steps({ block }: { block: StepsBlock }): ReactNode {
  const [index, setIndex] = useState(0);
  const step = stepAt(block, index);
  const last = block.steps.length - 1;
  return (
    <section className="la-steps" data-testid="block-steps">
      <MathText as="p" className="la-steps-title" text={block.title} testId="steps-title" />
      <p className="la-muted" data-testid="steps-progress">
        {stepProgress(block, index)}
      </p>
      <MathText as="p" className="la-steps-label" text={step.label} testId="steps-label" />
      <Prose markdown={step.markdown} />
      <p className="la-row">
        <button
          type="button"
          data-testid="steps-back"
          disabled={step.position === 0}
          onClick={() => setIndex(step.position - 1)}
        >
          Back
        </button>
        <button
          type="button"
          data-testid="steps-next"
          disabled={step.position === last}
          onClick={() => setIndex(step.position + 1)}
        >
          {step.position === last ? 'That is the last step' : 'Next step'}
        </button>
      </p>
    </section>
  );
}

function Block({ block }: { block: LessonBlock }): ReactNode {
  if (block.kind === 'prose') return <Prose markdown={block.markdown} />;
  if (block.kind === 'figure') return <Figure svg={block.svg} caption={block.caption} />;
  if (block.kind === 'table') return <TableFigure block={block} />;
  if (block.kind === 'check') return <Check block={block} />;
  if (block.kind === 'reveal') return <Reveal block={block} />;
  return <Steps block={block} />;
}

export type LessonBlocksProps = { blocks: readonly LessonBlock[] | undefined };

/**
 * WHY (F3 AC): a lesson written before this field existed has no blocks at all, and an empty
 * body is not a state worth a heading — the section is absent rather than present-and-empty,
 * exactly as a missing visualization is.
 */
export function LessonBlocks({ blocks }: LessonBlocksProps): ReactNode {
  if (blocks === undefined || blocks.length === 0) return null;
  return (
    <div data-testid="lesson-blocks">
      {blocks.map((block, index) => (
        <Block key={blockKey(block, index)} block={block} />
      ))}
    </div>
  );
}
