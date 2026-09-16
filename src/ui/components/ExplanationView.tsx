// FRACTAL: implements F3 | component C10
'use client';
import { useMemo, type ReactNode } from 'react';
import type { Explanation } from '@/shapes';
import { renderMarkdown } from '@/ui/sanitize';
import { videoLink } from '@/ui/lesson';
import { MathText } from '@/ui/components/MathText';

export type ExplanationViewProps = { explanation: Explanation };

function minutesOf(durationSec: number): string {
  const minutes = Math.max(1, Math.round(durationSec / 60));
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

function VideoExplanation({
  explanation,
}: {
  explanation: Extract<Explanation, { kind: 'video' }>;
}): ReactNode {
  const link = videoLink(explanation.url);
  if (!link.safe) {
    return (
      <div className="la-warn" role="alert" data-testid="video-blocked">
        <p>{link.reason}</p>
        <p>
          You can search for “<MathText text={explanation.title} />” yourself if you would like
          to watch it.
        </p>
      </div>
    );
  }
  return (
    <div data-testid="video-explanation">
      <p>
        <a href={link.href} target={link.target} rel={link.rel} data-testid="video-link">
          Watch “<MathText text={explanation.title} />”
        </a>{' '}
        <span className="la-muted">
          from <MathText text={explanation.channel} /> · {minutesOf(explanation.durationSec)} ·
          opens in a new tab
        </span>
      </p>
      <MathText as="p" text={explanation.why} />
    </div>
  );
}

function TextExplanation({ markdown }: { markdown: string }): ReactNode {
  const html = useMemo(() => renderMarkdown(markdown), [markdown]);
  return (
    <div
      data-testid="text-explanation"
      className="la-prose"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Model-written text never reaches the page as markup: it is escaped, then re-marked-up here. */
export function ExplanationView({ explanation }: ExplanationViewProps): ReactNode {
  return (
    <section className="la-card" data-testid="explanation">
      <h3>The explanation</h3>
      {explanation.kind === 'video' ? (
        <VideoExplanation explanation={explanation} />
      ) : (
        <TextExplanation markdown={explanation.markdown} />
      )}
    </section>
  );
}
