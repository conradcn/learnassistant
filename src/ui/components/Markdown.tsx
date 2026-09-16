// FRACTAL: implements F3, F4 | component C10
'use client';
import { useMemo, type ReactNode } from 'react';
import { renderMarkdown } from '@/ui/sanitize';

export type MarkdownProps = {
  markdown: string;
  className?: string;
  testId?: string;
};

/**
 * WHY: the model writes markdown everywhere it writes prose — a tutor's reply arrives with
 * headings, lists and code fences in it just as a lesson explanation does. Rendering that
 * string as one text node put the markers on the page and the reply on screen as a wall of
 * text. This is the same escape-then-re-mark-up path the lesson body uses, so a chat reply
 * is no more trusted than an explanation is.
 */
export function Markdown({ markdown, className, testId }: MarkdownProps): ReactNode {
  const html = useMemo(() => renderMarkdown(markdown), [markdown]);
  return (
    <div
      className={className === undefined ? 'la-prose' : `la-prose ${className}`}
      data-testid={testId}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
