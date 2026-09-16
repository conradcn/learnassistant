// FRACTAL: implements F3 | component C10
'use client';
import { useMemo, type ReactNode } from 'react';
import type { Visualization } from '@/shapes';
import { sanitizeSvg } from '@/ui/sanitize';
import { MathText } from '@/ui/components/MathText';

export type VisualizationViewProps = { visualization: Visualization };

function SvgFigure({ svg, caption }: { svg: string; caption: string }): ReactNode {
  const safe = useMemo(() => sanitizeSvg(svg), [svg]);
  return (
    <figure data-testid="visualization-svg">
      <div dangerouslySetInnerHTML={{ __html: safe }} />
      <MathText as="figcaption" className="la-muted" text={caption} />
    </figure>
  );
}

/**
 * WHY (F3 AC): "no picture for this lesson" is not a state worth a box on the page, so the
 * whole section is absent rather than present-and-empty.
 */
export function VisualizationView({ visualization }: VisualizationViewProps): ReactNode {
  if (visualization.kind === 'none') return null;

  if (visualization.kind === 'svg') {
    return (
      <section className="la-card" data-testid="visualization">
        <h3>A picture of it</h3>
        <SvgFigure svg={visualization.svg} caption={visualization.caption} />
      </section>
    );
  }

  return (
    <section className="la-card" data-testid="visualization">
      <h3>A picture of it</h3>
      <figure data-testid="visualization-table">
        <table>
          <thead>
            <tr>
              {visualization.headers.map((header) => (
                <th key={header} scope="col">
                  <MathText text={header} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visualization.rows.map((row, rowIndex) => (
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
        <MathText as="figcaption" className="la-muted" text={visualization.caption} />
      </figure>
    </section>
  );
}
