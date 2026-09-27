// FRACTAL: implements F3 | component C10
import type { PlotBlock, PlotParam } from '@/shapes';
import { compileExpression, type Scope } from '@/core/expr';

/**
 * The arithmetic behind an interactive plot, kept out of the component so the thing worth
 * testing — where the curve goes, what happens at an asymptote, how the axes scale as a
 * slider moves — can be tested without rendering anything.
 */

/** How many points a curve is sampled at. Enough to look smooth; small enough to redraw on drag. */
export const SAMPLES = 240;

/** The drawing box, in the SVG's own units. The plot itself scales with the page. */
export const VIEW = { width: 640, height: 360, left: 64, right: 16, top: 20, bottom: 48 } as const;

export type PlotPoint = { x: number; y: number };
/** One unbroken run of the curve. A curve splits into several across an asymptote or a gap. */
export type CurveSegment = readonly PlotPoint[];
export type SampledCurve = { label: string; segments: readonly CurveSegment[] };
export type PlotRange = { min: number; max: number };

/** The slider positions a plot starts at, by name. */
export function initialValues(block: PlotBlock): Record<string, number> {
  const values: Record<string, number> = {};
  for (const param of block.params) values[param.name] = param.value;
  return values;
}

/**
 * Sample every curve across the x range at the given slider positions. Points that are not
 * finite — a log of a negative, a division by zero — end the current segment rather than the
 * curve: an asymptote is a hole in the line, not a reason to stop drawing.
 */
export function sampleCurves(block: PlotBlock, values: Scope): SampledCurve[] {
  const names = ['x', ...block.params.map((p) => p.name)];
  const span = block.xMax - block.xMin;
  return block.curves.map((curve) => {
    const compiled = compileExpression(curve.expression, names);
    if (!compiled.ok) return { label: curve.label, segments: [] };
    const segments: PlotPoint[][] = [];
    let current: PlotPoint[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const x = block.xMin + (span * i) / (SAMPLES - 1);
      const y = compiled.evaluate({ ...values, x });
      if (Number.isFinite(y)) current.push({ x, y });
      else if (current.length > 0) {
        segments.push(current);
        current = [];
      }
    }
    if (current.length > 0) segments.push(current);
    return { label: curve.label, segments: segments.filter((s) => s.length > 1) };
  });
}

/**
 * The vertical range to draw in.
 *
 * WHY autoscale is the default and a fixed range the exception: the author cannot know
 * where a curve goes once the learner starts dragging, and a plot whose interesting part has
 * slid off the top teaches nothing. An author who DOES want the axis pinned — because the
 * point is that the curve approaches 1, say — pins it.
 *
 * WHY the autoscale ignores the extremes rather than fitting them: a curve with an asymptote
 * reaches a few hundred right beside the pole and stays under 5 everywhere else. Fitting the
 * true maximum flattens the whole lesson into a line along the x axis, which is precisely
 * the part the learner needed to see. The middle 96% of the sampled values is what the plot
 * is about; the rest runs off the top of the box, where an asymptote belongs.
 */
const TAIL_FRACTION = 0.02;

export function verticalRange(block: PlotBlock, curves: readonly SampledCurve[]): PlotRange {
  if (block.yMin !== undefined && block.yMax !== undefined) return { min: block.yMin, max: block.yMax };
  const values: number[] = [];
  for (const curve of curves) for (const segment of curve.segments) for (const point of segment) values.push(point.y);
  values.sort((a, b) => a - b);
  const cut = Math.floor(values.length * TAIL_FRACTION);
  let min = values[cut];
  let max = values[values.length - 1 - cut];

  // Nothing plotted, or a flat line: fall back to a range that at least has a height, so the
  // axes still draw and the learner sees an empty box rather than a collapsed one.
  if (min === undefined || max === undefined || !Number.isFinite(min) || !Number.isFinite(max)) {
    min = -1;
    max = 1;
  } else if (max - min < 1e-9) {
    min -= 1;
    max += 1;
  } else {
    const padding = (max - min) * 0.08;
    min -= padding;
    max += padding;
  }
  // A pinned floor above every sampled value (or a pinned ceiling below one) would invert
  // the axis; the pin wins and the other end is pushed out to keep the box a box.
  const lo = block.yMin ?? min;
  const hi = block.yMax ?? max;
  return lo < hi ? { min: lo, max: hi } : { min: lo, max: lo + 1 };
}

/**
 * How far outside the drawn range a point may be and still be joined to its neighbours,
 * as a multiple of the range's own height.
 */
const OFF_SCREEN = 1;

/**
 * Break every curve where it leaves the box entirely. WHY this is not left to the SVG's own
 * clipping: a sample at $x=-0.004$ and the next at $x=+0.004$ of $1/x$ are a thousand apart,
 * and joining them draws a vertical line straight through the pole — a learner reads that as
 * the function crossing zero there, which is the opposite of what an asymptote does. A point
 * just outside the box is kept, so a curve climbing out of frame still climbs.
 */
export function clipToRange(curves: readonly SampledCurve[], range: PlotRange): SampledCurve[] {
  const slack = (range.max - range.min) * OFF_SCREEN;
  const floor = range.min - slack;
  const ceiling = range.max + slack;
  return curves.map((curve) => {
    const segments: PlotPoint[][] = [];
    for (const segment of curve.segments) {
      let current: PlotPoint[] = [];
      for (const point of segment) {
        if (point.y >= floor && point.y <= ceiling) current.push(point);
        else {
          // The offending point itself is kept as the segment's last, so the line leaves the
          // box at the edge rather than stopping short of it.
          if (current.length > 0) segments.push([...current, point]);
          current = [];
        }
      }
      if (current.length > 0) segments.push(current);
    }
    return { label: curve.label, segments: segments.filter((s) => s.length > 1) };
  });
}

/** Map a data point into the SVG's coordinates, with y flipped the way screens count it. */
export function project(point: PlotPoint, block: PlotBlock, range: PlotRange): PlotPoint {
  const plotWidth = VIEW.width - VIEW.left - VIEW.right;
  const plotHeight = VIEW.height - VIEW.top - VIEW.bottom;
  const tx = (point.x - block.xMin) / (block.xMax - block.xMin);
  const ty = (point.y - range.min) / (range.max - range.min);
  return { x: VIEW.left + tx * plotWidth, y: VIEW.top + (1 - ty) * plotHeight };
}

/**
 * One segment as an SVG path. Points outside the vertical range are kept rather than
 * clipped — the SVG clips them for us, and dropping them would flatten a steep climb into a
 * horizontal jump across the top of the box.
 */
export function segmentPath(segment: CurveSegment, block: PlotBlock, range: PlotRange): string {
  return segment
    .map((point, index) => {
      const { x, y } = project(point, block, range);
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

/**
 * Tick values across a range, at a round interval near the requested count. WHY round
 * numbers matter: an axis labelled 0.0833, 0.1667 is an axis nobody reads, and the whole
 * argument for a plot is that it can be read at a glance.
 */
export function ticks(range: PlotRange, count = 5): number[] {
  const span = range.max - range.min;
  if (!(span > 0)) return [range.min];
  const rough = span / count;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalized = rough / magnitude;
  const step = (normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1) * magnitude;
  const out: number[] = [];
  const first = Math.ceil(range.min / step) * step;
  for (let value = first; value <= range.max + step * 1e-6; value += step) {
    // The multiply-round-divide undoes the drift that repeated addition accumulates.
    out.push(Math.round(value / step) * step);
  }
  return out;
}

/** A tick or slider value written the way a person would write it, not as 0.30000000000000004. */
export function formatValue(value: number, step?: number): string {
  if (Object.is(value, -0)) return '0';
  const decimals =
    step === undefined
      ? Math.min(4, Math.max(0, -Math.floor(Math.log10(Math.abs(value) || 1)) + 2))
      : Math.max(0, Math.ceil(-Math.log10(step)));
  const fixed = value.toFixed(Math.min(decimals, 6));
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') || '0' : fixed;
}

/**
 * A slider's new value, snapped to its own step and held inside its range. WHY snap here
 * rather than trust the input element: a range input agrees about the step only when the
 * step divides the span exactly, and a value that drifts off the grid makes the readout
 * disagree with the handle.
 */
export function snap(param: PlotParam, raw: number): number {
  if (!Number.isFinite(raw)) return param.value;
  const steps = Math.round((raw - param.min) / param.step);
  const snapped = param.min + steps * param.step;
  return Math.min(param.max, Math.max(param.min, Number(snapped.toPrecision(12))));
}
