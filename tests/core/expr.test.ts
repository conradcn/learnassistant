// FRACTAL: covers F3 | type unit | path lesson-body-is-interleaved
import { describe, expect, it } from 'vitest';
import { compileExpression, expressionError, MAX_EXPRESSION_CHARS } from '@/core/expr';

function value(source: string, scope: Record<string, number> = {}): number {
  const result = compileExpression(source, Object.keys(scope));
  if (!result.ok) throw new Error(`did not compile: ${result.error}`);
  return result.evaluate(scope);
}

describe('the formula language a plot is written in', () => {
  it('does the arithmetic a curve is made of', () => {
    expect(value('1 + 2 * 3')).toBe(7);
    expect(value('(1 + 2) * 3')).toBe(9);
    expect(value('7 / 2')).toBe(3.5);
    expect(value('2 ^ 3 ^ 2')).toBe(512);
    expect(value('1e-3 + 1')).toBeCloseTo(1.001, 10);
  });

  it('reads -x^2 as the negated square, the way the prose beside it will', () => {
    expect(value('-x ^ 2', { x: 3 })).toBe(-9);
    expect(value('(-x) ^ 2', { x: 3 })).toBe(9);
    expect(value('2 ^ -x', { x: 2 })).toBe(0.25);
  });

  it('knows the functions and constants a lesson actually reaches for', () => {
    expect(value('sin(0)')).toBe(0);
    expect(value('cos(pi)')).toBe(-1);
    expect(value('log2(8)')).toBe(3);
    expect(value('max(min(4, 9), 2)')).toBe(4);
    expect(value('exp(ln(5))')).toBeCloseTo(5, 10);
  });

  it('reads the variable and the sliders out of the scope it is called with', () => {
    const compiled = compileExpression('a * sin(b * x)', ['x', 'a', 'b']);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.evaluate({ x: Math.PI / 2, a: 2, b: 1 })).toBeCloseTo(2, 10);
    expect(compiled.evaluate({ x: Math.PI / 2, a: 2, b: 2 })).toBeCloseTo(0, 10);
  });

  it('returns NaN rather than throwing when a name is missing at draw time', () => {
    const compiled = compileExpression('a * x', ['x', 'a']);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(Number.isNaN(compiled.evaluate({ x: 1 }))).toBe(true);
  });

  it('gives back a non-finite number at an asymptote instead of failing', () => {
    expect(value('1 / x', { x: 0 })).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(value('ln(x)', { x: -1 }))).toBe(true);
  });
});

describe('what the formula language refuses', () => {
  // WHY these are tested as hard refusals rather than as "it happens not to work": the
  // formula arrives from a model, is stored, and is re-read in the browser. It is untrusted
  // input, and the guarantee wanted is that there is no way through it to the JS engine.
  it('has no way to reach JavaScript', () => {
    expect(expressionError('x.constructor', ['x'])).not.toBeNull();
    expect(expressionError('window', ['x'])).not.toBeNull();
    expect(expressionError('alert(1)', ['x'])).not.toBeNull();
    expect(expressionError('x = 1', ['x'])).not.toBeNull();
    expect(expressionError('x; y', ['x'])).not.toBeNull();
    expect(expressionError('`x`', ['x'])).not.toBeNull();
  });

  it('names the slider that was never declared', () => {
    const error = expressionError('a * x', ['x']);
    expect(error).toContain('"a"');
  });

  it('turns down a malformed formula rather than half-reading it', () => {
    expect(expressionError('1 +', ['x'])).not.toBeNull();
    expect(expressionError('(1 + 2', ['x'])).not.toBeNull();
    expect(expressionError('1 2', ['x'])).not.toBeNull();
    expect(expressionError('sin(1, 2)', ['x'])).toContain('one argument');
    expect(expressionError('pow(2)', ['x'])).toContain('two arguments');
    expect(expressionError('', ['x'])).not.toBeNull();
  });

  it('will not read a formula long enough to be a denial of service', () => {
    expect(expressionError('1+'.repeat(MAX_EXPRESSION_CHARS) + '1', ['x'])).toContain('longer than');
    expect(expressionError('('.repeat(40) + 'x' + ')'.repeat(40), ['x'])).toContain('deeply');
  });
});
