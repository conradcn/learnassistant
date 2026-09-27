// FRACTAL: implements F3 | component C0
/**
 * A tiny arithmetic language, compiled to a closure.
 *
 * WHY this exists rather than `new Function(source)`: a lesson's plot is written by a model
 * and stored in the database, so its formula is untrusted input that arrives at the browser
 * exactly the way a lesson's SVG does. Sanitising markup and then handing the same author a
 * JavaScript evaluator would be theatre. This language has no property access, no calls it
 * did not define, no assignment and no loops — the worst a hostile formula can do is return
 * NaN, which the plot already has to survive because real functions have asymptotes.
 *
 * It is also the schema's proof-reader: `compileExpression` is what lets C0 refuse a plot
 * whose curve mentions a slider that does not exist, in the same breath as it refuses a
 * check whose answer is not among its options.
 */

/** Bounds a formula so a pathological one cannot be expensive to parse or to read. */
export const MAX_EXPRESSION_CHARS = 240;
const MAX_DEPTH = 32;

/** What a formula may name besides its own variables. Everything else is an unknown name. */
const CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

const UNARY_FUNCTIONS: Readonly<Record<string, (x: number) => number>> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  log2: Math.log2,
  sqrt: Math.sqrt,
  abs: Math.abs,
  sign: Math.sign,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
};

const BINARY_FUNCTIONS: Readonly<Record<string, (a: number, b: number) => number>> = {
  pow: Math.pow,
  min: Math.min,
  max: Math.max,
  mod: (a, b) => a % b,
  atan2: Math.atan2,
};

/** The names a lesson may use in a formula, for the authoring prompt to quote verbatim. */
export const EXPRESSION_VOCABULARY: readonly string[] = [
  ...Object.keys(UNARY_FUNCTIONS),
  ...Object.keys(BINARY_FUNCTIONS),
  ...Object.keys(CONSTANTS),
];

export type Scope = Readonly<Record<string, number>>;
export type CompiledExpression = (scope: Scope) => number;
export type CompileResult =
  | { ok: true; evaluate: CompiledExpression }
  | { ok: false; error: string };

type Token = { kind: 'number'; value: number } | { kind: 'name'; value: string } | { kind: 'op'; value: string };

class ExpressionError extends Error {}

const OPERATORS = new Set(['+', '-', '*', '/', '^', '(', ')', ',']);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (OPERATORS.has(ch)) {
      tokens.push({ kind: 'op', value: ch });
      i += 1;
      continue;
    }
    // WHY the exponent is part of the number and not a `+` waiting to be parsed: `1e-3` is
    // one literal, and splitting it would leave a dangling minus that parses as subtraction.
    const number = /^\d+(\.\d+)?([eE][+-]?\d+)?|^\.\d+([eE][+-]?\d+)?/.exec(source.slice(i));
    if (number !== null) {
      tokens.push({ kind: 'number', value: Number(number[0]) });
      i += number[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
    if (name !== null) {
      tokens.push({ kind: 'name', value: name[0] });
      i += name[0].length;
      continue;
    }
    throw new ExpressionError(`unexpected character "${ch}"`);
  }
  return tokens;
}

/**
 * Recursive descent, lowest precedence outward: sum → product → unary → power → atom.
 * WHY power binds tighter than unary minus: `-x^2` is the negated square everywhere else
 * a learner has met it written down, and a plot that disagreed with the prose beside it
 * would be teaching the wrong thing about notation.
 */
function parse(tokens: readonly Token[], allowed: ReadonlySet<string>): CompiledExpression {
  let at = 0;
  let depth = 0;

  const peek = (): Token | undefined => tokens[at];
  const isOp = (value: string): boolean => {
    const token = peek();
    return token !== undefined && token.kind === 'op' && token.value === value;
  };
  const eat = (value: string): void => {
    if (!isOp(value)) throw new ExpressionError(`expected "${value}"`);
    at += 1;
  };

  function sum(): CompiledExpression {
    let left = product();
    for (;;) {
      if (isOp('+')) {
        at += 1;
        const right = product();
        const l = left;
        left = (s) => l(s) + right(s);
      } else if (isOp('-')) {
        at += 1;
        const right = product();
        const l = left;
        left = (s) => l(s) - right(s);
      } else return left;
    }
  }

  function product(): CompiledExpression {
    let left = unary();
    for (;;) {
      if (isOp('*')) {
        at += 1;
        const right = unary();
        const l = left;
        left = (s) => l(s) * right(s);
      } else if (isOp('/')) {
        at += 1;
        const right = unary();
        const l = left;
        left = (s) => l(s) / right(s);
      } else return left;
    }
  }

  function unary(): CompiledExpression {
    if (isOp('-')) {
      at += 1;
      const operand = unary();
      return (s) => -operand(s);
    }
    if (isOp('+')) {
      at += 1;
      return unary();
    }
    return power();
  }

  function power(): CompiledExpression {
    const base = atom();
    if (!isOp('^')) return base;
    at += 1;
    // Right-associative, and the exponent may itself be negated: `2^-x`.
    const exponent = unary();
    return (s) => Math.pow(base(s), exponent(s));
  }

  function atom(): CompiledExpression {
    depth += 1;
    if (depth > MAX_DEPTH) throw new ExpressionError('nested too deeply');
    try {
      const token = peek();
      if (token === undefined) throw new ExpressionError('ended early');
      if (token.kind === 'number') {
        at += 1;
        return () => token.value;
      }
      if (token.kind === 'op' && token.value === '(') {
        at += 1;
        const inner = sum();
        eat(')');
        return inner;
      }
      if (token.kind !== 'name') throw new ExpressionError(`unexpected "${token.value}"`);
      at += 1;
      const name = token.value;
      if (isOp('(')) {
        at += 1;
        const args: CompiledExpression[] = [];
        if (!isOp(')')) {
          args.push(sum());
          while (isOp(',')) {
            at += 1;
            args.push(sum());
          }
        }
        eat(')');
        const unaryFn = UNARY_FUNCTIONS[name];
        if (unaryFn !== undefined) {
          if (args.length !== 1) throw new ExpressionError(`${name}() takes one argument`);
          const [arg] = args;
          return (s) => unaryFn(arg(s));
        }
        const binaryFn = BINARY_FUNCTIONS[name];
        if (binaryFn !== undefined) {
          if (args.length !== 2) throw new ExpressionError(`${name}() takes two arguments`);
          const [a, b] = args;
          return (s) => binaryFn(a(s), b(s));
        }
        throw new ExpressionError(`there is no function called "${name}"`);
      }
      const constant = CONSTANTS[name];
      if (constant !== undefined) return () => constant;
      if (!allowed.has(name)) throw new ExpressionError(`"${name}" is not the variable or a slider`);
      // WHY a missing name reads as NaN rather than throwing: the compiled closure runs
      // inside a render, and a plot with one bad curve should lose that curve, not the page.
      return (s) => (typeof s[name] === 'number' ? s[name] : Number.NaN);
    } finally {
      depth -= 1;
    }
  }

  const compiled = sum();
  if (at !== tokens.length) throw new ExpressionError('there is more here than one formula');
  return compiled;
}

/**
 * Compile `source` into a function of `allowed` names. The error, when there is one, is
 * written to be read by whoever has to fix the formula — the authoring model, via the
 * schema's refusal message.
 */
export function compileExpression(source: string, allowed: readonly string[]): CompileResult {
  if (source.trim() === '') return { ok: false, error: 'the formula is empty' };
  if (source.length > MAX_EXPRESSION_CHARS) {
    return { ok: false, error: `the formula is longer than ${MAX_EXPRESSION_CHARS} characters` };
  }
  try {
    return { ok: true, evaluate: parse(tokenize(source), new Set(allowed)) };
  } catch (error) {
    if (error instanceof ExpressionError) return { ok: false, error: error.message };
    throw error;
  }
}

/** Whether a formula parses against these names — the schema's half of `compileExpression`. */
export function expressionError(source: string, allowed: readonly string[]): string | null {
  const result = compileExpression(source, allowed);
  return result.ok ? null : result.error;
}
