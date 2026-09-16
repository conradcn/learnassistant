// FRACTAL: implements F3 | component C10
'use client';
import { useMemo, type ReactNode } from 'react';
import { renderTextWithMath } from '@/ui/sanitize';

export type MathTextProps = {
  text: string;
  /** The element to render as — a stem sits in a `<p>`, a table cell in nothing at all. */
  as?: 'p' | 'span' | 'li' | 'div' | 'figcaption';
  className?: string;
  testId?: string;
};

/**
 * WHY (F3): a plain-string field is still a place a learner meets math. Rendering the
 * string as a text node would put `\sum_{i=1}^{n} i` on the page verbatim; this typesets
 * the LaTeX and escapes everything around it, so the field is no more trusted than the
 * markdown explanation is.
 */
export function MathText({ text, as = 'span', className, testId }: MathTextProps): ReactNode {
  const html = useMemo(() => renderTextWithMath(text), [text]);
  const Tag = as;
  return (
    <Tag
      className={className}
      data-testid={testId}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
