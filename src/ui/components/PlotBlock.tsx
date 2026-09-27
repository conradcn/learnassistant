// FRACTAL: implements F3 | component C10
'use client';
import { useId, useMemo, useState, type ReactNode } from 'react';
import type { PlotBlock as PlotBlockShape } from '@/shapes';
import { MathText } from '@/ui/components/MathText';
import {
  clipToRange,
  formatValue,
  initialValues,
  project,
  sampleCurves,
  segmentPath,
  snap,
  ticks,
  verticalRange,
  VIEW,
} from '@/ui/plot';

/**
 * Up to three curves, told apart without relying on colour alone — the dash pattern carries
 * the same distinction for a learner who cannot see the difference between the hues.
 */
const CURVE_STYLES = [
  { stroke: 'var(--la-plot-1)', dash: undefined },
  { stroke: 'var(--la-plot-2)', dash: '7 4' },
  { stroke: 'var(--la-plot-3)', dash: '2 4' },
] as const;

/**
 * A plot the learner drives with sliders (F3).
 *
 * WHY the whole thing redraws on every input event rather than debouncing: the point of a
 * slider is that the curve moves WITH your thumb — a plot that catches up a moment later
 * reads as a series of pictures, which is the thing this block exists to replace. Two
 * hundred-odd samples of a handful of closures is nothing to do between frames.
 */
export function PlotFigure({ block }: { block: PlotBlockShape }): ReactNode {
  const [values, setValues] = useState(() => initialValues(block));
  const clipId = `plot-clip-${useId()}`;
  const { curves, range, xTicks, yTicks } = useMemo(() => {
    const sampled = sampleCurves(block, values);
    const vertical = verticalRange(block, sampled);
    return {
      curves: clipToRange(sampled, vertical),
      range: vertical,
      xTicks: ticks({ min: block.xMin, max: block.xMax }),
      yTicks: ticks(vertical, 4),
    };
  }, [block, values]);

  const plotRight = VIEW.width - VIEW.right;
  const plotBottom = VIEW.height - VIEW.bottom;
  const atDefaults = block.params.every(
    (param) => values[param.name] === param.value,
  );

  return (
    <figure className="la-plot" data-testid="block-plot">
      <MathText
        as="p"
        className="la-plot-title"
        text={block.title}
        testId="plot-title"
      />
      <svg
        viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
        className="la-plot-svg"
        role="img"
        aria-label={`${block.title}. ${block.caption}`}
        data-testid="plot-svg"
      >
        <defs>
          {/* Curves are clipped to the plot area so a steep one cannot run over the axis
              labels; the sampling has already broken them where they leave it entirely. */}
          <clipPath id={clipId}>
            <rect
              x={VIEW.left}
              y={VIEW.top}
              width={plotRight - VIEW.left}
              height={plotBottom - VIEW.top}
            />
          </clipPath>
        </defs>
        <g className="la-plot-grid">
          {yTicks.map((value) => {
            const y = project({ x: block.xMin, y: value }, block, range).y;
            return (
              <g key={`y-${value}`}>
                <line x1={VIEW.left} y1={y} x2={plotRight} y2={y} />
                <text x={VIEW.left - 8} y={y + 4} textAnchor="end">
                  {formatValue(value)}
                </text>
              </g>
            );
          })}
          {xTicks.map((value) => {
            const x = project({ x: value, y: range.min }, block, range).x;
            return (
              <g key={`x-${value}`}>
                <line x1={x} y1={VIEW.top} x2={x} y2={plotBottom} />
                <text x={x} y={plotBottom + 18} textAnchor="middle">
                  {formatValue(value)}
                </text>
              </g>
            );
          })}
        </g>
        <g className="la-plot-axes">
          <line x1={VIEW.left} y1={VIEW.top} x2={VIEW.left} y2={plotBottom} />
          <line x1={VIEW.left} y1={plotBottom} x2={plotRight} y2={plotBottom} />
          {/* The zero line, when it is inside the window, is the one gridline worth naming. */}
          {range.min < 0 && range.max > 0 ? (
            <line
              className="la-plot-zero"
              x1={VIEW.left}
              y1={project({ x: block.xMin, y: 0 }, block, range).y}
              x2={plotRight}
              y2={project({ x: block.xMin, y: 0 }, block, range).y}
            />
          ) : null}
        </g>
        <g clipPath={`url(#${clipId})`}>
          {curves.map((curve, index) => {
            const style = CURVE_STYLES[index % CURVE_STYLES.length];
            return (
              <g
                key={`${index}-${curve.label}`}
                data-testid={`plot-curve-${index}`}
              >
                {curve.segments.map((segment, segmentIndex) => (
                  <path
                    key={segmentIndex}
                    d={segmentPath(segment, block, range)}
                    fill="none"
                    stroke={style.stroke}
                    strokeDasharray={style.dash}
                    strokeWidth={2.5}
                    strokeLinejoin="round"
                  />
                ))}
              </g>
            );
          })}
        </g>
        <text
          className="la-plot-axis-label"
          x={(VIEW.left + plotRight) / 2}
          y={VIEW.height - 6}
          textAnchor="middle"
        >
          {block.xLabel}
        </text>
        <text
          className="la-plot-axis-label"
          transform={`translate(14 ${(VIEW.top + plotBottom) / 2}) rotate(-90)`}
          textAnchor="middle"
        >
          {block.yLabel}
        </text>
      </svg>
      {block.curves.length > 1 ? (
        <ul className="la-plot-legend" data-testid="plot-legend">
          {block.curves.map((curve, index) => (
            <li key={`${index}-${curve.label}`}>
              <span
                className="la-plot-swatch"
                style={{
                  background: CURVE_STYLES[index % CURVE_STYLES.length].stroke,
                }}
              />
              <MathText text={curve.label} />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="la-plot-controls">
        {block.params.map((param) => (
          <label
            key={param.name}
            className="la-plot-control"
            htmlFor={`plot-${param.name}`}
          >
            <span className="la-plot-control-label">
              <MathText text={param.label} />
              <output data-testid={`plot-value-${param.name}`}>
                {param.name} = {formatValue(values[param.name], param.step)}
              </output>
            </span>
            <input
              id={`plot-${param.name}`}
              type="range"
              min={param.min}
              max={param.max}
              step={param.step}
              value={values[param.name]}
              data-testid={`plot-slider-${param.name}`}
              onChange={(event) =>
                setValues((previous) => ({
                  ...previous,
                  [param.name]: snap(param, Number(event.target.value)),
                }))
              }
            />
          </label>
        ))}
      </div>
      <p className="la-row la-plot-reset">
        <button
          type="button"
          data-testid="plot-reset"
          disabled={atDefaults}
          onClick={() => setValues(initialValues(block))}
        >
          Back to where it started
        </button>
      </p>
      <MathText
        as="figcaption"
        className="la-muted"
        text={block.caption}
        testId="plot-caption"
      />
    </figure>
  );
}
