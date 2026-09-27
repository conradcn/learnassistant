// FRACTAL: covers F3 | type unit | path lesson-body-is-interleaved
import { describe, expect, it } from 'vitest';
import type { PlotBlock } from '@/shapes';
import { examplePlotBlock, lessonBlockSchema } from '@/shapes';
import { clipToRange, formatValue, initialValues, sampleCurves, snap, ticks, verticalRange } from '@/ui/plot';

function plot(overrides: Partial<PlotBlock> = {}): PlotBlock {
  return {
    kind: 'plot',
    title: 'A line',
    caption: 'Drag the slope.',
    xLabel: 'x',
    yLabel: 'y',
    xMin: -1,
    xMax: 1,
    params: [{ name: 'm', label: 'Slope', min: -2, max: 2, step: 0.5, value: 1 }],
    curves: [{ label: 'y = m x', expression: 'm * x' }],
    ...overrides,
  };
}

describe('sampling a plot', () => {
  it('follows the sliders — the same curve is a different line at a different setting', () => {
    const block = plot();
    const flat = sampleCurves(block, { m: 0 })[0].segments[0];
    const steep = sampleCurves(block, { m: 2 })[0].segments[0];
    expect(flat.every((point) => point.y === 0)).toBe(true);
    expect(steep[steep.length - 1].y).toBeCloseTo(2, 6);
  });

  it('breaks the line at an asymptote instead of drawing through it', () => {
    // WHY this is the test that matters for 1/x: joined across the pole, the curve draws a
    // vertical line through zero, which reads as the function crossing there.
    const block = plot({ curves: [{ label: '1/x', expression: '1 / x' }] });
    const sampled = sampleCurves(block, { m: 1 });
    const [curve] = clipToRange(sampled, verticalRange(block, sampled));
    expect(curve.segments.length).toBeGreaterThan(1);
    for (const segment of curve.segments) {
      expect(segment.every((point) => Number.isFinite(point.y))).toBe(true);
    }
    // Every segment stays on one side of the pole: none of them contains both signs of x.
    for (const segment of curve.segments) {
      const signs = new Set(segment.map((point) => Math.sign(point.x)));
      expect(signs.has(-1) && signs.has(1)).toBe(false);
    }
  });

  it('keeps the interesting part of a curve on screen when it has an asymptote', () => {
    // Without this, 1/x's spike near the pole sets the scale and everything else is a flat
    // line along the axis — the plot technically fits and teaches nothing.
    const block = plot({ curves: [{ label: '1/x', expression: '1 / x' }] });
    const range = verticalRange(block, sampleCurves(block, { m: 1 }));
    expect(range.max).toBeLessThan(200);
  });

  it('drops a curve it cannot compile rather than the whole plot', () => {
    const block = plot({
      curves: [
        { label: 'good', expression: 'm * x' },
        { label: 'bad', expression: 'nope(x)' },
      ],
    });
    const curves = sampleCurves(block, { m: 1 });
    expect(curves[0].segments.length).toBe(1);
    expect(curves[1].segments).toEqual([]);
  });

  it('starts every slider where the author put it', () => {
    expect(initialValues(plot())).toEqual({ m: 1 });
  });
});

describe('the vertical axis', () => {
  it('follows the curves when the author did not pin it', () => {
    const block = plot();
    const wide = verticalRange(block, sampleCurves(block, { m: 2 }));
    const narrow = verticalRange(block, sampleCurves(block, { m: 0.5 }));
    expect(wide.max).toBeGreaterThan(narrow.max);
    expect(wide.max).toBeGreaterThanOrEqual(2);
  });

  it('stays where it was pinned, so a plot can make a point about a limit', () => {
    const block = plot({ yMin: -10, yMax: 10 });
    expect(verticalRange(block, sampleCurves(block, { m: 1 }))).toEqual({ min: -10, max: 10 });
  });

  it('still has a height when the curve is flat or missing entirely', () => {
    const flat = verticalRange(plot(), sampleCurves(plot(), { m: 0 }));
    expect(flat.max).toBeGreaterThan(flat.min);
    const empty = verticalRange(plot(), []);
    expect(empty.max).toBeGreaterThan(empty.min);
  });
});

describe('the axis labels and the slider readout', () => {
  it('puts ticks on round numbers a learner can read at a glance', () => {
    expect(ticks({ min: 0, max: 1 }).map((v) => formatValue(v))).toEqual(['0', '0.2', '0.4', '0.6', '0.8', '1']);
    expect(ticks({ min: -10, max: 10 })).toContain(0);
    expect(ticks({ min: 5, max: 5 })).toEqual([5]);
  });

  it('writes a value the way a person would', () => {
    expect(formatValue(0.30000000000000004, 0.1)).toBe('0.3');
    expect(formatValue(-0)).toBe('0');
    expect(formatValue(3, 1)).toBe('3');
  });

  it('snaps a slider to its own step and holds it inside its range', () => {
    const [param] = plot().params;
    expect(snap(param, 0.7)).toBe(0.5);
    expect(snap(param, 99)).toBe(2);
    expect(snap(param, -99)).toBe(-2);
    expect(snap(param, Number.NaN)).toBe(param.value);
  });
});

describe('the plot contract', () => {
  it('takes the example plot as written', () => {
    expect(lessonBlockSchema.safeParse(examplePlotBlock).success).toBe(true);
  });

  it('refuses a curve that names a slider nobody declared', () => {
    const parsed = lessonBlockSchema.safeParse(plot({ curves: [{ label: 'y', expression: 'k * x' }] }));
    expect(parsed.success).toBe(false);
    expect(parsed.success ? '' : parsed.error.issues[0].message).toContain('"k"');
  });

  it('refuses a slider that starts outside its own range, or shadows the x axis', () => {
    expect(
      lessonBlockSchema.safeParse(plot({ params: [{ name: 'm', label: 'm', min: 0, max: 1, step: 0.1, value: 4 }] }))
        .success,
    ).toBe(false);
    expect(
      lessonBlockSchema.safeParse(
        plot({ params: [{ name: 'x', label: 'x', min: 0, max: 1, step: 0.1, value: 0 }], curves: [{ label: 'y', expression: 'x' }] }),
      ).success,
    ).toBe(false);
  });

  it('refuses an axis that runs backwards', () => {
    expect(lessonBlockSchema.safeParse(plot({ xMin: 1, xMax: -1 })).success).toBe(false);
    expect(lessonBlockSchema.safeParse(plot({ yMin: 1, yMax: -1 })).success).toBe(false);
  });
});
