// FRACTAL: implements F4, F9, F13 | component C6
import { z } from 'zod';
import { assistLevelSchema, evalVerdictSchema, type EvalVerdict } from '@/shapes';
import { err } from '@/core/errors';
import { log } from '@/core/log';
import { learnerMessageSchema, MAX_LEARNER_MESSAGE_BYTES, type LearnerMessage } from '@/eval/shapes';

export const MAX_EVALUATOR_OUTPUT_BYTES = 256 * 1024;
export const MAX_REPLY_CHARS = 20000;

export const evaluatorModeSchema = z.union([
  z.literal('question'),
  z.literal('hint'),
  z.literal('explanation'),
  z.literal('teach-back'),
  z.literal('verdict'),
]);

/**
 * WHY clipped rather than capped: these bounds exist to keep an unbounded model string
 * out of the store, not to judge the answer. Rejecting the whole turn because one of
 * them ran long threw away a reply the learner was waiting on and told them the
 * evaluator had gone silent — which is exactly what a real Claude CLI session did, on
 * a `nextAngle` of a couple of hundred characters. The whole payload is already capped
 * at MAX_EVALUATOR_OUTPUT_BYTES before it gets here, so nothing unbounded reaches this
 * point and the only question left is what to do with a field that is merely long.
 */
function clipped(max: number): z.ZodEffects<z.ZodString, string, string> {
  return z.string().transform((s) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`));
}

/**
 * WHY a fallback instead of a rejection: an unrecognised value in either of these two
 * fields is a vocabulary miss, not a broken turn. `continue` and `explanation` are the
 * inert choices — they show the reply, keep the conversation open, and grant no
 * completion — so guessing them costs the learner nothing, while refusing the turn
 * costs them the whole exchange.
 */
function withFallback<T extends string>(schema: z.ZodType<T>, fallback: T): z.ZodType<T> {
  return z.preprocess((v) => (schema.safeParse(v).success ? v : fallback), schema) as z.ZodType<T>;
}

/**
 * WHY absent is not the same as wrong: these fields are the evaluator's bookkeeping, not
 * its answer. A real Claude session returned a complete, well-judged reply for a lesson on
 * $\mathbb{R}^n$ and simply left `remedialNeeded` out of the JSON — one boolean it had
 * nothing to say about — and zod's "Required" threw the whole turn away. The learner was
 * told the evaluator had gone silent, and because the message they had already sent stays
 * in the transcript, every reopen asked the same question and lost the same reply again.
 * An omitted flag has an inert reading in every case: no remedial asked for, no assistance
 * claimed, no misunderstanding named, no rationale offered — and a missing rationale still
 * fails closed at `enforcePassCriteria`, which grants nothing without evidence. `reply` is
 * the one field with no inert reading, so it stays required.
 */
function whenAbsent<S extends z.ZodTypeAny>(schema: S, fallback: unknown): z.ZodType<z.infer<S>> {
  return z.preprocess((v) => (v === undefined || v === null ? fallback : v), schema) as z.ZodType<z.infer<S>>;
}

const outcomeSchema = z.union([
  z.literal('pass'),
  z.literal('assisted-pass'),
  z.literal('fail'),
  z.literal('continue'),
]);

// WHY not `.strict()` any more: an extra key the model volunteered ("confidence",
// "notes") is not a reason to lose the turn. Unknown keys are dropped, which is the
// same protection strict gave — nothing unexpected reaches the store — without
// throwing away everything that WAS asked for.
export const rawVerdictSchema = z.object({
  outcome: withFallback(outcomeSchema, 'continue'),
  // WHY 0 and not the running level: `applyHintLadder` takes the max of this and the level
  // the transcript already records, so an unstated level can never lower the account of
  // how much help the learner has had.
  assistLevel: whenAbsent(assistLevelSchema, 0),
  misunderstanding: clipped(4000).nullable().default(null),
  nextAngle: clipped(200).nullable().default(null),
  remedialNeeded: whenAbsent(z.boolean(), false),
  rationale: whenAbsent(clipped(8000), ''),
});

export const evaluatorOutputSchema = z.object({
  reply: clipped(MAX_REPLY_CHARS).pipe(z.string().min(1)),
  mode: withFallback(evaluatorModeSchema, 'explanation'),
  angle: clipped(200).nullable().default(null),
  verdict: rawVerdictSchema,
});
export type EvaluatorOutput = z.infer<typeof evaluatorOutputSchema>;

export type EvaluatorParse =
  | { ok: true; value: EvaluatorOutput }
  | { ok: false; reason: 'too-large' | 'not-json' | 'bad-shape' };

// WHY: the CLI's stdout is untrusted model-generated content. It is capped,
// JSON-parsed, and schema-validated before a single field is read, and the raw
// text never crosses back to the caller — only the reason code does.
export function parseRawEvaluatorOutput(raw: string): EvaluatorParse {
  if (Buffer.byteLength(raw, 'utf8') > MAX_EVALUATOR_OUTPUT_BYTES) {
    return { ok: false, reason: 'too-large' };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not-json' };
  }
  return parseEvaluatorOutput(json);
}

export function parseEvaluatorOutput(value: unknown): EvaluatorParse {
  const parsed = evaluatorOutputSchema.safeParse(value);
  if (!parsed.success) return { ok: false, reason: 'bad-shape' };
  return { ok: true, value: { ...parsed.data, reply: sanitizeEvaluatorText(parsed.data.reply) } };
}

const TAG_RE = /<[^>]*>/g;
const DANGEROUS_URL_RE = /\b(javascript|data|vbscript):/gi;

// WHY: the evaluator's reply is rendered as Markdown with HTML disabled, so any
// tag-looking run and any script-bearing URL scheme is removed here, at ingest,
// rather than trusted to a renderer flag downstream.
export function sanitizeEvaluatorText(text: string): string {
  return text.replace(TAG_RE, '').replace(DANGEROUS_URL_RE, 'blocked:');
}

/**
 * WHY: pass criteria for a notation-heavy lesson are written in LaTeX, and a control
 * word like `\mathcal` or `\mathbb` survives the punctuation strip below as the plain
 * token "mathcal" — a word no learner and no evaluator rationale would ever write in
 * prose. Left in, those tokens pad the denominator of the overlap ratio with terms that
 * are unmatchable by construction, so a criterion made mostly of symbols could not be
 * cleared however well the learner had actually cleared it. That is not hypothetical:
 * it swallowed a real pass on "Reading Math Notation Like a Type Signature". Macro
 * names are removed here so the ratio is computed over the words that carry meaning.
 */
function stripLatex(s: string): string {
  return s.replace(/\\[a-zA-Z]+/g, ' ');
}

/**
 * WHY a rubric stopword list and a stemmer: a pass criterion is written as an instruction to
 * the grader — "Computes ... correctly", "States that ...", "Offers at least one ..." — while a
 * rationale is written as a report of what the learner did — "computed ... through to the final
 * sum", "named it a scalar". The grading verbs are pure scaffolding: they describe the act of
 * assessing, never the thing assessed, so an unmatchable "computes" or "identifies" in every
 * criterion padded the denominator the same way LaTeX macros did. Inflection did the rest —
 * "computes" and "computed" are the same claim and were counted as a miss. That combination
 * swallowed a fully-evidenced, unassisted pass on "The Dot Product as a Weighted Sum": the best
 * criterion scored 0.47 against a rationale that had, in plain words, satisfied all six.
 * Scaffolding is dropped and both sides are stemmed so the ratio is computed over claims.
 */
const RUBRIC_STOPWORDS = new Set([
  'learner',
  'correctly',
  'unprompted',
  'explicitly',
  'least',
  'rather',
  'than',
  'instead',
  'without',
  'includ',
  'stat',
  'explain',
  'describ',
  'identifi',
  'comput',
  'predict',
  'offer',
  'give',
  'show',
  'say',
  'us',
  'note',
  'mention',
  'answer',
  'able',
  'that',
  'this',
  'their',
  'them',
  'they',
  'with',
  'from',
  'when',
  'what',
  'which',
]);

// WHY a crude suffix stripper and not a real stemmer: the only inflection gap that matters here
// is criterion-voice against rationale-voice ("names"/"named", "vector"/"vectors"), and a
// four-suffix strip closes it without a dependency. The minimum stem length keeps short words
// ("uses", "goes") from collapsing into noise that could match anything.
function stem(word: string): string {
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) return word.slice(0, -suffix.length);
  }
  return word;
}

function contentWords(s: string): string[] {
  return stripLatex(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .map(stem)
    .filter((w) => !RUBRIC_STOPWORDS.has(w));
}

export const PASS_CRITERIA_OVERLAP = 0.5;

// WHY (H3, fail closed): a verdict that grants completion is the one decision
// the model can make that changes durable state, so it is only honoured when
// its rationale actually references the module's pass criteria. No criteria
// means no evidence, which means no pass.
export function rationaleSupportsPassCriteria(rationale: string, passCriteria: string[]): boolean {
  if (passCriteria.length === 0) return false;
  const said = new Set(contentWords(rationale));
  return passCriteria.some((criterion) => {
    const words = contentWords(criterion);
    if (words.length === 0) return false;
    const hits = words.filter((w) => said.has(w)).length;
    return hits / words.length >= PASS_CRITERIA_OVERLAP;
  });
}

export function grantsCompletion(outcome: EvalVerdict['outcome']): boolean {
  return outcome === 'pass' || outcome === 'assisted-pass';
}

export function enforcePassCriteria(verdict: EvalVerdict, passCriteria: string[], correlationId: string): EvalVerdict {
  if (!grantsCompletion(verdict.outcome)) return verdict;
  if (rationaleSupportsPassCriteria(verdict.rationale, passCriteria)) return verdict;
  log({
    level: 'warn',
    event: 'eval-pass-unsupported-by-criteria',
    component: 'C6',
    correlationId,
    criteriaCount: passCriteria.length,
  });
  return {
    ...verdict,
    outcome: 'continue',
    rationale: 'Let us keep going — that has not covered what this lesson asks for yet.',
  };
}

export function toEvalVerdict(raw: z.infer<typeof rawVerdictSchema>): EvalVerdict {
  return evalVerdictSchema.parse(raw);
}

// WHY: the learner's text is the one field an attacker-shaped payload could
// arrive in; it is length-bounded at the boundary before it is persisted, sent
// or logged, and rejected rather than truncated so nothing is silently altered.
export function validateLearnerMessage(message: unknown): LearnerMessage {
  const parsed = learnerMessageSchema.safeParse(message);
  if (!parsed.success) {
    throw err('validation', {
      detail: 'learner message failed boundary validation',
      userMessage: `Your message needs to be between 1 and ${MAX_LEARNER_MESSAGE_BYTES} characters.`,
    });
  }
  return parsed.data;
}
