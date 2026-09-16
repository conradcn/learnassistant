// FRACTAL: implements F3 | component C4
//
// WHY this file exists: the migration is a plain `.mjs` script — it is run with bare node,
// before and outside the build, so it deliberately is not TypeScript. Its unit tests are,
// and `allowJs` is off, so without these declarations importing it is an implicit `any`
// and `tsc --noEmit` fails on the test file. Declaring the surface keeps the script
// runnable by node alone and the suite type-checked.

/** Rewrites one Unicode/backtick maths span into LaTeX source (no delimiters). */
export function toLatex(raw: string): string;

/** Decides whether a backtick span is a formula or genuinely code. */
export function classifySpan(body: string): 'math' | 'code';

/** Converts backtick spans and standalone bold formula lines; fenced code is untouched. */
export function convertMarkdown(md: string): string;

/** Walks every learner-facing string of a ModuleContent, returning a converted clone. */
export function convertContent<T>(content: T): T;

/** Typesets every formula in `content` with errors fatal, returning what failed. */
export function validateMath(content: unknown): Promise<{ tex: string; reason: string }[]>;

/** Must match contentDigest() in src/orchestrator/reconcile.ts. */
export function digestOf(content: unknown): string;

/** Drains the conversions recorded since the last call. */
export function takeRecord(): { kind: string; before: string; after: string }[];
