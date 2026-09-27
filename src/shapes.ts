// FRACTAL: implements (none) | component C0
import { z } from 'zod';
import { expressionError, MAX_EXPRESSION_CHARS } from '@/core/expr';

export const TOPIC_ID_RE = /^t_[A-Za-z0-9]{16}$/;
export const MODULE_ID_RE = /^m_[A-Za-z0-9]{16}$/;
export const SESSION_ID_RE = /^s_[A-Za-z0-9]{16}$/;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const isoDateStringSchema = z.string().regex(ISO_DATE_RE).brand<'ISODateString'>();
export type ISODateString = z.infer<typeof isoDateStringSchema>;
export const exampleISODateString: ISODateString = isoDateStringSchema.parse('2026-08-22T09:14:03.000Z');

export const topicIdSchema = z.string().regex(TOPIC_ID_RE).brand<'TopicId'>();
export type TopicId = z.infer<typeof topicIdSchema>;
export const exampleTopicId: TopicId = topicIdSchema.parse('t_9fQ2xK4mZa71bC0d');

export const moduleIdSchema = z.string().regex(MODULE_ID_RE).brand<'ModuleId'>();
export type ModuleId = z.infer<typeof moduleIdSchema>;
export const exampleModuleId: ModuleId = moduleIdSchema.parse('m_71bC0d9fQ2xK4mZa');

export const sessionIdSchema = z.string().regex(SESSION_ID_RE).brand<'SessionId'>();
export type SessionId = z.infer<typeof sessionIdSchema>;
export const exampleSessionId: SessionId = sessionIdSchema.parse('s_4mZa71bC0d9fQ2xK');

export const levelSchema = z.union([
  z.literal('beginner'),
  z.literal('intermediate'),
  z.literal('advanced'),
  z.literal('self-described'),
]);
export type Level = z.infer<typeof levelSchema>;
export const exampleLevel: Level = 'intermediate';

export const topicStatusSchema = z.union([
  z.literal('queued'),
  z.literal('generating'),
  z.literal('ready'),
  z.literal('ready-with-notes'),
  z.literal('needs-attention'),
  z.literal('modules-complete'),
  z.literal('done'),
]);
export type TopicStatus = z.infer<typeof topicStatusSchema>;
export const exampleTopicStatus: TopicStatus = 'ready';

export const moduleStateSchema = z.union([
  z.literal('not-yet-recommended'),
  z.literal('available'),
  z.literal('in-progress'),
  z.literal('completed'),
  z.literal('assisted-pass'),
  z.literal('needs-review'),
]);
export type ModuleState = z.infer<typeof moduleStateSchema>;
export const exampleModuleState: ModuleState = 'available';

export const assistLevelSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export type AssistLevel = z.infer<typeof assistLevelSchema>;
export const exampleAssistLevel: AssistLevel = 2;

export const selfAssessmentSchema = z.object({
  confidence: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  critique: z.string(),
});
export type SelfAssessment = z.infer<typeof selfAssessmentSchema>;
export const exampleSelfAssessment: SelfAssessment = {
  confidence: 3,
  critique: 'I hand-waved the expectation step.',
};

export const evalTurnSchema = z.object({
  id: z.string(),
  role: z.union([z.literal('learner'), z.literal('evaluator')]),
  text: z.string(),
  assistLevel: assistLevelSchema.nullable(),
  angle: z.string().nullable(),
  mode: z.union([
    z.literal('question'),
    z.literal('hint'),
    z.literal('explanation'),
    z.literal('teach-back'),
    z.literal('verdict'),
  ]),
  selfAssessment: selfAssessmentSchema.nullable(),
  at: isoDateStringSchema,
});
export type EvalTurn = z.infer<typeof evalTurnSchema>;
export const exampleEvalTurn: EvalTurn = {
  id: 'e7',
  role: 'evaluator',
  text: 'Suppose the outcomes are not equally likely...',
  assistLevel: null,
  angle: 'gambling odds',
  mode: 'question',
  selfAssessment: null,
  at: exampleISODateString,
};

export const diagnosticTranscriptSchema = z.object({
  skipped: z.boolean(),
  exchanges: z.array(evalTurnSchema),
  priorKnowledge: z.array(z.string()),
});
export type DiagnosticTranscript = z.infer<typeof diagnosticTranscriptSchema>;
export const exampleDiagnosticTranscript: DiagnosticTranscript = {
  skipped: true,
  exchanges: [],
  priorKnowledge: [],
};

/**
 * One step of the intake diagnostic (F1). `answer` is the learner's reply to the question
 * the transcript is waiting on (null to start, or to ask for the first question again);
 * `skip` ends it where it stands. The transcript itself lives on the server — the page
 * sends words, never a transcript it could have edited.
 */
export const diagnosticTurnRequestSchema = z
  .object({
    answer: z.string().trim().max(2000).nullable().default(null),
    skip: z.boolean().default(false),
  })
  .strict();
export type DiagnosticTurnRequest = z.infer<typeof diagnosticTurnRequestSchema>;

export const diagnosticTurnResultSchema = z.object({
  transcript: diagnosticTranscriptSchema,
  /** The question now waiting on the learner, or null once the diagnostic is over. */
  question: z.string().nullable(),
});
export type DiagnosticTurnResult = z.infer<typeof diagnosticTurnResultSchema>;
export const exampleDiagnosticTurnResult: DiagnosticTurnResult = {
  transcript: exampleDiagnosticTranscript,
  question: null,
};

export const topicNoteSchema = z.object({
  kind: z.union([
    z.literal('discontinuity'),
    z.literal('graph-defect'),
    z.literal('cross-topic'),
    z.literal('generation-failure'),
  ]),
  message: z.string(),
  affectedModules: z.array(moduleIdSchema),
  createdAt: isoDateStringSchema,
});
export type TopicNote = z.infer<typeof topicNoteSchema>;
export const exampleTopicNote: TopicNote = {
  kind: 'discontinuity',
  message: "Module 4 uses 'entropy rate' before module 3 defines it.",
  affectedModules: [exampleModuleId],
  createdAt: exampleISODateString,
};

/**
 * WHY a ceiling at all: a learner can legitimately bring a 900-page textbook, and the
 * whole of it is never what a session reads — C11 chunks it. The cap is on what is kept
 * on disk and indexed, and crossing it is REPORTED (`truncated`) rather than done quietly.
 */
export const MAX_SOURCE_CHARS = 2_000_000;
/** The biggest single upload accepted, before extraction. */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
/**
 * The most pages read out of one PDF.
 *
 * WHY a page ceiling as well as a character one: the character cap is applied to text that
 * already EXISTS, so on its own it bounds nothing — a 3,000-page scan-with-a-text-layer is
 * 3,000 `getTextContent()` calls before anyone counts a character, in the single process
 * that also serves the UI and the generation stream. This bounds the reading itself. It sits
 * well above any real syllabus and above most textbooks, and crossing it is reported
 * (`truncated`) exactly like crossing the character cap.
 */
export const MAX_SOURCE_PAGES = 600;

export const SOURCE_ID_RE = /^sd_[A-Za-z0-9]{16}$/;
export const sourceIdSchema = z.string().regex(SOURCE_ID_RE).brand<'SourceId'>();
export type SourceId = z.infer<typeof sourceIdSchema>;
export const exampleSourceId: SourceId = sourceIdSchema.parse('sd_71bC0d9fQ2xK4mZa');

export const sourceKindSchema = z.union([
  z.literal('pdf'),
  z.literal('docx'),
  z.literal('text'),
  z.literal('markdown'),
  z.literal('pasted'),
]);
export type SourceKind = z.infer<typeof sourceKindSchema>;
export const exampleSourceKind: SourceKind = 'pdf';

/** One unit/week/chapter the material names for itself. The scope F2 is held to. */
export const sourceUnitSchema = z.object({
  label: z.string().max(60),
  title: z.string().max(300),
});
export type SourceUnit = z.infer<typeof sourceUnitSchema>;
export const exampleSourceUnit: SourceUnit = { label: 'Unit 3', title: 'Entropy and mutual information' };

export const sourceDocumentSchema = z.object({
  id: sourceIdSchema,
  topicId: topicIdSchema,
  filename: z.string().max(300),
  kind: sourceKindSchema,
  byteSize: z.number().int().min(0),
  charCount: z.number().int().min(0),
  pageCount: z.number().int().min(0).nullable(),
  truncated: z.boolean(),
  units: z.array(sourceUnitSchema),
  addedAt: isoDateStringSchema,
});
export type SourceDocument = z.infer<typeof sourceDocumentSchema>;
export const exampleSourceDocument: SourceDocument = {
  id: exampleSourceId,
  topicId: exampleTopicId,
  filename: 'info-theory-syllabus.pdf',
  kind: 'pdf',
  byteSize: 48213,
  charCount: 6120,
  pageCount: 3,
  truncated: false,
  units: [exampleSourceUnit],
  addedAt: exampleISODateString,
};

/**
 * An upload that has been read but does not belong to a subject yet: the intake form
 * needs the subject it infers before there is a topic to store it under.
 */
export const stagedSourceSchema = z.object({
  id: sourceIdSchema,
  filename: z.string().max(300),
  kind: sourceKindSchema,
  byteSize: z.number().int().min(0),
  charCount: z.number().int().min(0),
  pageCount: z.number().int().min(0).nullable(),
  truncated: z.boolean(),
  units: z.array(sourceUnitSchema),
  inferredSubject: z.string().max(200).nullable(),
  /** The level the material itself reads as, when it says so plainly enough to tell. */
  levelSignal: levelSchema.nullable(),
  excerpt: z.string().max(600),
});
export type StagedSource = z.infer<typeof stagedSourceSchema>;
export const exampleStagedSource: StagedSource = {
  id: exampleSourceId,
  filename: 'info-theory-syllabus.pdf',
  kind: 'pdf',
  byteSize: 48213,
  charCount: 6120,
  pageCount: 3,
  truncated: false,
  units: [exampleSourceUnit],
  inferredSubject: 'Information theory',
  levelSignal: 'advanced',
  excerpt: 'Unit 1: Probability review ...',
};

export const topicSchema = z.object({
  id: topicIdSchema,
  subject: z.string(),
  level: levelSchema,
  levelDetail: z.string().optional(),
  purpose: z.string(),
  drivingQuestion: z.string().nullable(),
  status: topicStatusSchema,
  diagnostic: diagnosticTranscriptSchema.nullable(),
  notes: z.array(topicNoteSchema),
  createdAt: isoDateStringSchema,
  updatedAt: isoDateStringSchema,
});
export type Topic = z.infer<typeof topicSchema>;
export const exampleTopic: Topic = {
  id: exampleTopicId,
  subject: 'Information theory',
  level: 'intermediate',
  purpose: 'read Shannon and build a compressor with an agent',
  drivingQuestion: 'How small can a message get, and how do you know when you are done?',
  status: 'ready',
  diagnostic: null,
  notes: [],
  createdAt: exampleISODateString,
  updatedAt: isoDateStringSchema.parse('2026-08-22T09:41:00.000Z'),
};

export const teachBackMisconceptionSchema = z.object({
  id: z.string(),
  statement: z.string(),
  correction: z.string(),
});
export type TeachBackMisconception = z.infer<typeof teachBackMisconceptionSchema>;
export const exampleTeachBackMisconception: TeachBackMisconception = {
  id: 'tb1',
  statement: 'Entropy is just the length of the message.',
  correction: 'It is the expected code length under an optimal code.',
};

export const evalScriptSchema = z.object({
  objectives: z.array(z.string()),
  seedQuestions: z.array(z.string()),
  angles: z.array(z.string()),
  misconceptions: z.array(teachBackMisconceptionSchema),
  passCriteria: z.array(z.string()),
});
export type EvalScript = z.infer<typeof evalScriptSchema>;
export const exampleEvalScript: EvalScript = {
  objectives: ['Distinguish entropy from information content'],
  seedQuestions: ['Why is a fair coin one bit?'],
  angles: ['compression', 'gambling odds', 'twenty questions'],
  misconceptions: [],
  passCriteria: ['Explains why entropy is an expectation, not a per-symbol constant'],
};

export const explanationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('video'),
      url: z.string(),
      title: z.string(),
      channel: z.string(),
      durationSec: z.number(),
      why: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('text'),
      markdown: z.string(),
    })
    .strict(),
]);
export type Explanation = z.infer<typeof explanationSchema>;
export const exampleExplanation: Explanation = {
  kind: 'video',
  url: 'https://www.youtube.com/watch?v=ErfnhcEV1O8',
  title: 'Information entropy',
  channel: '3Blue1Brown',
  durationSec: 612,
  why: 'Visual derivation at exactly this level.',
};

export const visualizationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('svg'), svg: z.string(), caption: z.string() }),
  z.object({
    kind: z.literal('table'),
    headers: z.array(z.string()),
    rows: z.array(z.array(z.string())),
    caption: z.string(),
  }),
  z.object({ kind: z.literal('none') }),
]);
export type Visualization = z.infer<typeof visualizationSchema>;
export const exampleVisualization: Visualization = { kind: 'none' };

/**
 * The two sides of a card, and the size of the shelf they go on. WHY these live up here
 * rather than beside the rest of F14's shapes below: a lesson may arrive with a pack of
 * cards already written (`cardPackSchema`), so the card shape has to exist before the
 * lesson content that carries it.
 */
export const MAX_CARD_SIDE_CHARS = 2000;
export const MAX_DECK_NAME_CHARS = 120;

export const newCardSchema = z
  .object({
    front: z.string().min(1).max(MAX_CARD_SIDE_CHARS),
    back: z.string().min(1).max(MAX_CARD_SIDE_CHARS),
  })
  .strict();
export type NewCard = z.infer<typeof newCardSchema>;
export const exampleNewCard: NewCard = { front: 'Amine', back: '$-\mathrm{NH_2}$' };

/**
 * A plot the learner drives. WHY this and not another picture: a figure shows one case of a
 * relationship, and the thing worth learning is usually how the relationship MOVES — what
 * happens to the Gaussian as $\sigma$ grows, where the logistic saturates, which term stops
 * mattering as the exponent climbs. Ten static figures cannot say that; one curve with a
 * slider under it says it in the first drag.
 *
 * The curves are formulas in `x` and in the sliders' own names, compiled by C0's arithmetic
 * language (`@/core/expr`) rather than by the JavaScript engine — a lesson's formula is
 * model-written, stored and then re-read in the browser, so it is untrusted exactly as a
 * lesson's SVG is.
 */
export const MAX_PLOT_PARAMS = 4;
export const MAX_PLOT_CURVES = 3;
export const PLOT_VARIABLE = 'x';
export const PLOT_PARAM_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,15}$/;

const plotParamSchema = z
  .object({
    /** The name the curves use for this slider. Must not shadow the horizontal variable. */
    name: z.string().regex(PLOT_PARAM_NAME_RE),
    label: z.string().min(1),
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().finite().positive(),
    /** Where the slider sits when the learner first meets the plot. */
    value: z.number().finite(),
  })
  .strict();
export type PlotParam = z.infer<typeof plotParamSchema>;

const plotCurveSchema = z
  .object({
    label: z.string().min(1),
    /** A formula in `x` and the slider names, e.g. `a * sin(b * x)`. */
    expression: z.string().min(1).max(MAX_EXPRESSION_CHARS),
  })
  .strict();
export type PlotCurve = z.infer<typeof plotCurveSchema>;

const plotBlockSchema = z
  .object({
    kind: z.literal('plot'),
    title: z.string().min(1),
    /** What to watch for while dragging — the point of the plot, in one or two lines. */
    caption: z.string().min(1),
    xLabel: z.string(),
    yLabel: z.string(),
    xMin: z.number().finite(),
    xMax: z.number().finite(),
    /** Both omitted means the vertical axis follows the curves as the sliders move. */
    yMin: z.number().finite().optional(),
    yMax: z.number().finite().optional(),
    params: z.array(plotParamSchema).min(1).max(MAX_PLOT_PARAMS),
    curves: z.array(plotCurveSchema).min(1).max(MAX_PLOT_CURVES),
  })
  .strict();
export type PlotBlock = z.infer<typeof plotBlockSchema>;

/**
 * Everything about a plot that cannot be said in the shape alone. WHY each is a refusal
 * rather than a repair: a slider whose range excludes its own starting value, or a curve
 * naming a slider nobody declared, is a plot whose author meant something we cannot guess —
 * and guessing is inventing the teaching, the same reason a misaimed `answerIndex` is
 * refused rather than clamped.
 */
function checkPlot(block: PlotBlock, ctx: z.RefinementCtx): void {
  if (block.xMin >= block.xMax) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['xMax'], message: 'xMax must be greater than xMin' });
  }
  if (block.yMin !== undefined && block.yMax !== undefined && block.yMin >= block.yMax) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['yMax'], message: 'yMax must be greater than yMin' });
  }
  const seen = new Set<string>();
  for (const [index, param] of block.params.entries()) {
    const path = ['params', index] as const;
    if (param.name === PLOT_VARIABLE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, 'name'],
        message: `"${PLOT_VARIABLE}" is the horizontal axis and cannot also be a slider`,
      });
    }
    if (seen.has(param.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, 'name'],
        message: `two sliders are both called "${param.name}"`,
      });
    }
    seen.add(param.name);
    if (param.min >= param.max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'max'], message: 'max must be greater than min' });
    }
    if (param.value < param.min || param.value > param.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, 'value'],
        message: 'value must sit between min and max',
      });
    }
  }
  const names = [PLOT_VARIABLE, ...block.params.map((p) => p.name)];
  for (const [index, curve] of block.curves.entries()) {
    const error = expressionError(curve.expression, names);
    if (error !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['curves', index, 'expression'],
        message: `${error} (available names: ${names.join(', ')})`,
      });
    }
  }
}

/**
 * A visualization the lesson writes as code: HTML, CSS and JavaScript, run as written in a
 * sandboxed frame (C10, `@/ui/viz-frame`).
 *
 * WHY a block that executes model-written script, in an app whose every other model string is
 * escaped or sanitized: a simulation, a draggable construction, an animation of an algorithm
 * cannot be written down as data, and `plot` is the ceiling of what a declarative block can
 * express. This was a deliberate decision to accept arbitrary script from the authoring model
 * — contained by an opaque-origin sandbox and a no-network policy, not by inspecting the code.
 * The schema checks only size: a string of HTML has no shape to check, and anything short of
 * running it is a guess about what it does.
 */
export const MAX_INTERACTIVE_HTML_CHARS = 60_000;

const interactiveBlockSchema = z
  .object({
    kind: z.literal('interactive'),
    title: z.string().min(1),
    /** What to do with it and what to notice — also the frame's accessible name. */
    caption: z.string().min(1),
    /** A body fragment or a whole document; either is written into the frame as-is. */
    html: z.string().min(1).max(MAX_INTERACTIVE_HTML_CHARS),
    /** The frame's height until the content reports its own, in CSS pixels. */
    height: z.number().int().min(80).max(1600).optional(),
  })
  .strict();
export type InteractiveBlock = z.infer<typeof interactiveBlockSchema>;

/**
 * One piece of the lesson body. WHY (F3): a module used to be one slab of markdown with at
 * most a single picture appended underneath, so a twenty-minute lesson read as a wall of
 * text the learner scrolled rather than worked through. A lesson is instead a SEQUENCE of
 * these — prose is interrupted by something to look at or something to do, and the thing to
 * do sits at the point in the argument it belongs to rather than at the end.
 *
 * Every interactive kind here is ungraded and unrecorded: it exists to make the learner
 * commit to an answer before reading on, which is the same bet the warm-up makes (F3), not
 * to measure them. Measurement is F4's job and stays there.
 */
const lessonBlockVariantSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('prose'), markdown: z.string() }).strict(),
  z.object({ kind: z.literal('figure'), svg: z.string(), caption: z.string() }).strict(),
  z
    .object({
      kind: z.literal('table'),
      headers: z.array(z.string()),
      rows: z.array(z.array(z.string())),
      caption: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('check'),
      question: z.string(),
      options: z.array(z.string()).min(2),
      /** Index into `options`, checked against them below. */
      answerIndex: z.number().int().min(0),
      whyRight: z.string(),
      whyWrong: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reveal'),
      prompt: z.string(),
      answer: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('steps'),
      title: z.string(),
      steps: z.array(z.object({ label: z.string(), markdown: z.string() }).strict()).min(2),
    })
    .strict(),
  plotBlockSchema,
  interactiveBlockSchema,
]);

/**
 * WHY the range check lives out here rather than on the variant: a discriminated union's
 * members must be plain objects, and a refined member is no longer one. WHY it is a refusal
 * rather than a clamp: a check whose answer is not among its options has no right answer,
 * and choosing one on the model's behalf would be inventing the teaching.
 */
export const lessonBlockSchema = lessonBlockVariantSchema.superRefine((block, ctx) => {
  if (block.kind === 'plot') checkPlot(block, ctx);
  if (block.kind === 'check' && block.answerIndex >= block.options.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['answerIndex'],
      message: 'answerIndex must point at one of the options',
    });
  }
});
export type LessonBlock = z.infer<typeof lessonBlockSchema>;
export const exampleLessonBlock: LessonBlock = {
  kind: 'check',
  question: 'How many yes/no questions pin down one of $8$ equally likely outcomes?',
  options: ['$8$', '$3$', '$4$'],
  answerIndex: 1,
  whyRight: 'Each question halves the field, and $\log_2 8 = 3$.',
  whyWrong: 'Counting the outcomes rather than the halvings gives $8$.',
};

export const examplePlotBlock: PlotBlock = {
  kind: 'plot',
  title: 'Entropy of a biased coin',
  caption: 'Drag the bias. The peak is at a fair coin, and it falls away fast in both directions.',
  xLabel: 'p (probability of heads)',
  yLabel: 'bits',
  xMin: 0.001,
  xMax: 0.999,
  params: [{ name: 'n', label: 'Flips averaged over', min: 1, max: 10, step: 1, value: 1 }],
  curves: [
    { label: 'H(p) per flip', expression: '0 - (x * log2(x) + (1 - x) * log2(1 - x))' },
    { label: 'Total over n flips', expression: 'n * (0 - (x * log2(x) + (1 - x) * log2(1 - x)))' },
  ],
};

export const exampleInteractiveBlock: InteractiveBlock = {
  kind: 'interactive',
  title: 'Twenty questions, halved',
  caption: 'Click to ask one yes/no question. Count how many it takes to pin down 1 of 16.',
  html:
    '<p id="out">16 left</p><button id="ask">Ask a question</button>' +
    '<script>let n=16;ask.onclick=()=>{n=Math.max(1,n/2);out.textContent=n+" left";};</script>',
  height: 120,
};

export const warmUpSchema = z.object({
  prompt: z.string(),
  expectedStruggle: z.string(),
});
export type WarmUp = z.infer<typeof warmUpSchema>;
export const exampleWarmUp: WarmUp = {
  prompt: 'Before reading: how many yes/no questions pin down one of 8 equally likely outcomes? Why?',
  expectedStruggle: 'Answering 8 rather than 3.',
};

/**
 * What the learner already did with this lesson's warm-up, read back from their notes so a
 * revisit shows their own first go instead of an empty box.
 */
export const warmUpRecordSchema = z.object({
  stage: z.enum(['attempted', 'skipped']),
  text: z.string(),
});
export type WarmUpRecord = z.infer<typeof warmUpRecordSchema>;
export const exampleWarmUpRecord: WarmUpRecord = { stage: 'attempted', text: 'Three, one per halving.' };

/**
 * One question the learner asked about a lesson while reading it, and the answer they got.
 * Kept because a question worth asking is worth finding again on the next visit; stored as
 * a note (C8) so it needs no table of its own.
 */
export const lessonQuestionSchema = z.object({
  question: z.string(),
  answer: z.string(),
});
export type LessonQuestion = z.infer<typeof lessonQuestionSchema>;
export const exampleLessonQuestion: LessonQuestion = {
  question: 'Why is entropy measured in bits rather than in questions?',
  answer: 'A bit IS one yes/no question, so the two units are the same thing named twice.',
};

/**
 * A set of flash cards a lesson wrote for itself while it was being planned (F14 x F2).
 *
 * WHY a lesson gets to write cards at all, when this app refuses to reward recall
 * everywhere else: the exception F14 already names — the flat facts. A lesson on
 * functional groups can derive nothing that tells the learner the group is CALLED a
 * carboxyl, and the session that just wrote the lesson is the one thing in the system
 * that knows which handful of names in it are like that. So it may propose a pack, and
 * only propose: nothing is added to the learner's cards until they ask for it, because a
 * deck that filled itself up behind them is a chore they never chose.
 */
export const MAX_PACK_CARDS = 20;
export const cardPackSchema = z
  .object({
    name: z.string().min(1).max(MAX_DECK_NAME_CHARS),
    /** Why these facts are worth knowing by heart — one line, shown above the cards. */
    why: z.string().max(300),
    cards: z.array(newCardSchema).min(1).max(MAX_PACK_CARDS),
  })
  .strict();
export type CardPack = z.infer<typeof cardPackSchema>;
export const exampleCardPack: CardPack = {
  name: 'Entropy: the words',
  why: 'Nothing derives these names — you either know them or you stop mid-sentence.',
  cards: [{ front: 'Entropy', back: 'The expected surprise of a distribution, in bits.' }],
};

export const moduleContentSchema = z.object({
  learningGoals: z.array(z.string()),
  warmUp: warmUpSchema,
  explanation: explanationSchema,
  /**
   * The interleaved body of the lesson, read after `explanation`. Deliberately OPTIONAL and
   * without a default: every lesson written before this field existed is still valid, and a
   * zod default would materialise `blocks: []` into content that was digested without it,
   * failing every stored lesson's checksum on load (see contentDigest in C4/reconcile).
   */
  blocks: z.array(lessonBlockSchema).optional(),
  /**
   * The flash cards this lesson proposes, if any. OPTIONAL for the same reason `blocks`
   * is: a lesson written before this field existed must still load, and a zod default
   * would change the object the digest was taken over. A lesson with no flat facts worth
   * memorising omits it rather than shipping an empty pack — see `cardPackSchema`.
   */
  cardPack: cardPackSchema.optional(),
  visualization: visualizationSchema,
  evalScript: evalScriptSchema,
  authoredAt: isoDateStringSchema,
  authoredBySession: sessionIdSchema,
});
export type ModuleContent = z.infer<typeof moduleContentSchema>;
export const exampleModuleContent: ModuleContent = {
  learningGoals: ['State entropy as expected surprise'],
  warmUp: exampleWarmUp,
  explanation: { kind: 'text', markdown: '...' },
  visualization: exampleVisualization,
  evalScript: exampleEvalScript,
  authoredAt: isoDateStringSchema.parse('2026-08-22T09:30:00.000Z'),
  authoredBySession: exampleSessionId,
};

export const moduleNodeSchema = z.object({
  id: moduleIdSchema,
  topicId: topicIdSchema,
  title: z.string(),
  ordinal: z.number(),
  kind: z.union([z.literal('module'), z.literal('detour'), z.literal('remedial'), z.literal('capstone')]),
  testOutEligible: z.boolean(),
  estimatedMinutes: z.number(),
  state: moduleStateSchema,
  content: moduleContentSchema.nullable(),
});
export type ModuleNode = z.infer<typeof moduleNodeSchema>;
export const exampleModuleNode: ModuleNode = {
  id: exampleModuleId,
  topicId: exampleTopicId,
  title: 'Entropy as expected surprise',
  ordinal: 3,
  kind: 'module',
  testOutEligible: false,
  estimatedMinutes: 20,
  state: 'available',
  content: null,
};

export const prereqEdgeSchema = z.object({
  from: moduleIdSchema,
  to: moduleIdSchema,
});
export type PrereqEdge = z.infer<typeof prereqEdgeSchema>;
export const examplePrereqEdge: PrereqEdge = {
  from: exampleModuleId,
  to: moduleIdSchema.parse('m_0d9fQ2xK4mZa71bC'),
};

export const moduleGraphSchema = z.object({
  topicId: topicIdSchema,
  nodes: z.array(moduleNodeSchema),
  edges: z.array(prereqEdgeSchema),
  entryModules: z.array(moduleIdSchema),
});
export type ModuleGraph = z.infer<typeof moduleGraphSchema>;
export const exampleModuleGraph: ModuleGraph = {
  topicId: exampleTopicId,
  nodes: [],
  edges: [],
  entryModules: [],
};

export const evalVerdictSchema = z.object({
  outcome: z.union([z.literal('pass'), z.literal('assisted-pass'), z.literal('fail'), z.literal('continue')]),
  assistLevel: assistLevelSchema,
  misunderstanding: z.string().nullable(),
  nextAngle: z.string().nullable(),
  remedialNeeded: z.boolean(),
  rationale: z.string(),
});
export type EvalVerdict = z.infer<typeof evalVerdictSchema>;
export const exampleEvalVerdict: EvalVerdict = {
  outcome: 'fail',
  assistLevel: 1,
  misunderstanding: 'Treats entropy as a property of one symbol.',
  nextAngle: 'twenty questions',
  remedialNeeded: false,
  rationale: 'The answer never invoked the distribution.',
};

export const evalSessionSchema = z.object({
  id: sessionIdSchema,
  moduleId: moduleIdSchema,
  kind: z.union([
    z.literal('module'),
    z.literal('test-out'),
    z.literal('synthesis'),
    z.literal('capstone'),
    z.literal('review'),
    z.literal('diagnostic'),
  ]),
  turns: z.array(evalTurnSchema),
  consecutiveFailures: z.number(),
  status: z.union([z.literal('open'), z.literal('passed'), z.literal('abandoned')]),
  openedAt: isoDateStringSchema,
});
export type EvalSession = z.infer<typeof evalSessionSchema>;
export const exampleEvalSession: EvalSession = {
  id: exampleSessionId,
  moduleId: exampleModuleId,
  kind: 'module',
  turns: [],
  consecutiveFailures: 0,
  status: 'open',
  openedAt: isoDateStringSchema.parse('2026-08-22T10:00:00.000Z'),
};

/**
 * The FSRS-6 memory state for one review item: stability in days (the interval at which
 * recall probability reaches 0.9), difficulty in [1, 10], the count of graded retrievals,
 * and the instant of the last one.
 *
 * WHY it is nested and why nothing here reaches the browser: these are the numbers that
 * grow a dashboard the moment they are within reach of one, and F5 is explicit that
 * progress is never expressed as a grade. `ReviewCue` is the shape that crosses C9.
 * See `docs/spaced-repetition.md` §5.
 */
export const reviewMemorySchema = z
  .object({
    stability: z.number(),
    difficulty: z.number(),
    reps: z.number(),
    lastReviewedAt: isoDateStringSchema.nullable(),
  })
  .strict();
export type ReviewMemory = z.infer<typeof reviewMemorySchema>;
export const exampleReviewMemory: ReviewMemory = {
  stability: 2.3065,
  difficulty: 2.1181,
  reps: 1,
  lastReviewedAt: isoDateStringSchema.parse('2026-08-22T00:00:00.000Z'),
};

export const reviewItemSchema = z.object({
  moduleId: moduleIdSchema,
  dueAt: isoDateStringSchema,
  intervalDays: z.number(),
  lapses: z.number(),
  lastAssistLevel: assistLevelSchema,
  flaggedNeedsReview: z.boolean(),
  memory: reviewMemorySchema,
});
export type ReviewItem = z.infer<typeof reviewItemSchema>;
export const exampleReviewItem: ReviewItem = {
  moduleId: exampleModuleId,
  dueAt: isoDateStringSchema.parse('2026-08-25T00:00:00.000Z'),
  intervalDays: 3,
  lapses: 0,
  lastAssistLevel: 0,
  flaggedNeedsReview: false,
  memory: exampleReviewMemory,
};

/**
 * What a review item looks like from outside C7: when it is due and whether it is worth a
 * second look. No interval, no memory state, nothing a reader could rank a learner by.
 */
export const reviewCueSchema = z
  .object({
    moduleId: moduleIdSchema,
    dueAt: isoDateStringSchema,
    needsAnotherLook: z.boolean(),
  })
  .strict();
export type ReviewCue = z.infer<typeof reviewCueSchema>;
export const exampleReviewCue: ReviewCue = {
  moduleId: exampleModuleId,
  dueAt: isoDateStringSchema.parse('2026-08-25T00:00:00.000Z'),
  needsAnotherLook: false,
};

export const practiceQuestionSchema = z.object({
  moduleId: moduleIdSchema,
  topicId: topicIdSchema,
  text: z.string(),
  answered: z.boolean(),
  correct: z.boolean().nullable(),
});
export type PracticeQuestion = z.infer<typeof practiceQuestionSchema>;
export const examplePracticeQuestion: PracticeQuestion = {
  moduleId: exampleModuleId,
  topicId: exampleTopicId,
  text: 'Why does a skewed coin carry less than one bit?',
  answered: false,
  correct: null,
};

export const practiceSessionSchema = z.object({
  id: sessionIdSchema,
  questions: z.array(practiceQuestionSchema),
  answeredCount: z.number(),
  stoppedEarly: z.boolean(),
});
export type PracticeSession = z.infer<typeof practiceSessionSchema>;
export const examplePracticeSession: PracticeSession = {
  id: sessionIdSchema.parse('s_0d9fQ2xK4mZa71bC'),
  questions: [],
  answeredCount: 0,
  stoppedEarly: false,
};

export const predictionSchema = z.object({
  moduleId: moduleIdSchema,
  confidence: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  expectation: z.string(),
  skipped: z.boolean(),
  at: isoDateStringSchema,
});
export type Prediction = z.infer<typeof predictionSchema>;
export const examplePrediction: Prediction = {
  moduleId: exampleModuleId,
  confidence: 4,
  expectation: 'I probably know this from coding.',
  skipped: false,
  at: isoDateStringSchema.parse('2026-08-22T09:59:00.000Z'),
};

export const calibrationSchema = z.object({
  moduleId: moduleIdSchema,
  predicted: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).nullable(),
  actualAssistLevel: assistLevelSchema,
  selfVsEvaluator: z.array(
    z.object({
      turnId: z.string(),
      self: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
      evaluatorAssist: assistLevelSchema,
    }),
  ),
});
export type Calibration = z.infer<typeof calibrationSchema>;
export const exampleCalibration: Calibration = {
  moduleId: exampleModuleId,
  predicted: 4,
  actualAssistLevel: 2,
  selfVsEvaluator: [],
};

export const reflectionSchema = z.object({
  id: z.string(),
  topicId: topicIdSchema,
  moduleId: moduleIdSchema.nullable(),
  text: z.string(),
  createdAt: isoDateStringSchema,
  updatedAt: isoDateStringSchema,
});
export type Reflection = z.infer<typeof reflectionSchema>;
export const exampleReflection: Reflection = {
  id: 'r_1',
  topicId: exampleTopicId,
  moduleId: null,
  text: 'The expectation step is the part I keep skipping.',
  createdAt: isoDateStringSchema.parse('2026-08-22T10:20:00.000Z'),
  updatedAt: isoDateStringSchema.parse('2026-08-22T10:20:00.000Z'),
};

/**
 * F14's flash cards: the small stock of facts that simply have to be known by heart —
 * the names of the functional groups, a table of prefixes, a set of dates. Everything
 * else in this app refuses to reward recall; this is the one place where recall IS the
 * material, so it is kept apart from the module graph rather than folded into it.
 */
export const DECK_ID_RE = /^dk_[0-9a-f]{16}$/;
export const deckIdSchema = z.string().regex(DECK_ID_RE).brand<'DeckId'>();
export type DeckId = z.infer<typeof deckIdSchema>;
export const exampleDeckId: DeckId = deckIdSchema.parse('dk_0d9f2ca4b2a71bc0');

export const CARD_ID_RE = /^cd_[0-9a-f]{16}$/;
export const cardIdSchema = z.string().regex(CARD_ID_RE).brand<'CardId'>();
export type CardId = z.infer<typeof cardIdSchema>;
export const exampleCardId: CardId = cardIdSchema.parse('cd_71bc0d9f2ca4b2a0');

export const cardDeckSchema = z
  .object({
    id: deckIdSchema,
    /** A deck may hang off a subject the learner is studying, or stand on its own. */
    topicId: topicIdSchema.nullable(),
    name: z.string().min(1).max(MAX_DECK_NAME_CHARS),
    createdAt: isoDateStringSchema,
    updatedAt: isoDateStringSchema,
  })
  .strict();
export type CardDeck = z.infer<typeof cardDeckSchema>;
export const exampleCardDeck: CardDeck = {
  id: exampleDeckId,
  topicId: null,
  name: 'Functional groups',
  createdAt: isoDateStringSchema.parse('2026-08-22T10:20:00.000Z'),
  updatedAt: isoDateStringSchema.parse('2026-08-22T10:20:00.000Z'),
};

/**
 * A card as C1 holds it: both sides, plus the same DSR memory state F7 keeps for a
 * module. The memory half never leaves the server — see `cardViewSchema`.
 */
export const cardSchema = z
  .object({
    id: cardIdSchema,
    deckId: deckIdSchema,
    front: z.string().min(1).max(MAX_CARD_SIDE_CHARS),
    back: z.string().min(1).max(MAX_CARD_SIDE_CHARS),
    createdAt: isoDateStringSchema,
    updatedAt: isoDateStringSchema,
    dueAt: isoDateStringSchema,
    intervalDays: z.number(),
    lapses: z.number(),
    memory: reviewMemorySchema,
  })
  .strict();
export type Card = z.infer<typeof cardSchema>;
export const exampleCard: Card = {
  id: exampleCardId,
  deckId: exampleDeckId,
  front: 'Carboxyl group',
  back: '$-\mathrm{COOH}$ — a carbonyl and a hydroxyl on the same carbon.',
  createdAt: isoDateStringSchema.parse('2026-08-22T10:20:00.000Z'),
  updatedAt: isoDateStringSchema.parse('2026-08-22T10:20:00.000Z'),
  dueAt: isoDateStringSchema.parse('2026-08-22T10:20:00.000Z'),
  intervalDays: 0,
  lapses: 0,
  memory: { stability: 0, difficulty: 0, reps: 0, lastReviewedAt: null },
};

/**
 * What a card looks like from outside C7 — both sides, when it is next due, and nothing
 * else. Same rule as `ReviewCue`: stability, difficulty and retrievability stay server-side
 * (F5: progress is never expressed as a grade).
 */
export const cardViewSchema = z
  .object({
    id: cardIdSchema,
    deckId: deckIdSchema,
    front: z.string(),
    back: z.string(),
    dueAt: isoDateStringSchema,
    /** True before the card has ever been answered — it has no schedule yet, only a place in line. */
    unseen: z.boolean(),
  })
  .strict();
export type CardView = z.infer<typeof cardViewSchema>;
export const exampleCardView: CardView = {
  id: exampleCardId,
  deckId: exampleDeckId,
  front: exampleCard.front,
  back: exampleCard.back,
  dueAt: exampleCard.dueAt,
  unseen: true,
};

export const deckSummarySchema = z
  .object({
    deck: cardDeckSchema,
    subject: z.string().nullable(),
    cardCount: z.number(),
    dueCount: z.number(),
  })
  .strict();
export type DeckSummary = z.infer<typeof deckSummarySchema>;
export const exampleDeckSummary: DeckSummary = {
  deck: exampleCardDeck,
  subject: null,
  cardCount: 12,
  dueCount: 4,
};

/** The learner's own read of how the recall went. Three buttons, F7's three grades. */
export const cardGradeSchema = z.union([z.literal('missed'), z.literal('hard'), z.literal('knew-it')]);
export type CardGrade = z.infer<typeof cardGradeSchema>;
export const exampleCardGrade: CardGrade = 'knew-it';

/**
 * What pressing "add these to my cards" did: the deck they went into, the cards that were
 * new, and how many were already there. The count is stated rather than hidden because a
 * button that reports "added" for cards it did not add is lying about the learner's shelf.
 */
export const cardPackImportSchema = z
  .object({
    deck: cardDeckSchema,
    added: z.array(cardViewSchema),
    alreadyThere: z.number().int().min(0),
  })
  .strict();
export type CardPackImport = z.infer<typeof cardPackImportSchema>;
export const exampleCardPackImport: CardPackImport = {
  deck: exampleCardDeck,
  added: [exampleCardView],
  alreadyThere: 0,
};

/** What a paste of "term — meaning" lines turned into: the cards read, and the lines that were not. */
export const cardImportSchema = z
  .object({
    cards: z.array(newCardSchema),
    skipped: z.array(z.string()),
  })
  .strict();
export type CardImport = z.infer<typeof cardImportSchema>;
export const exampleCardImport: CardImport = { cards: [exampleNewCard], skipped: [] };

export const capstoneSubmissionSchema = z.object({
  round: z.number(),
  artifact: z.string(),
  feedback: z.string().nullable(),
  verdict: evalVerdictSchema.nullable(),
  at: isoDateStringSchema,
});
export type CapstoneSubmission = z.infer<typeof capstoneSubmissionSchema>;
export const exampleCapstoneSubmission: CapstoneSubmission = {
  round: 1,
  artifact: 'design notes plus a repo link',
  feedback: null,
  verdict: null,
  at: isoDateStringSchema.parse('2026-08-22T11:00:00.000Z'),
};

export const capstoneSchema = z.object({
  topicId: topicIdSchema,
  moduleId: moduleIdSchema,
  spec: z.string(),
  drivingQuestionRef: z.string(),
  purposeRef: z.string(),
  submissions: z.array(capstoneSubmissionSchema),
  status: z.union([z.literal('not-started'), z.literal('in-review'), z.literal('passed')]),
});
export type Capstone = z.infer<typeof capstoneSchema>;
export const exampleCapstone: Capstone = {
  topicId: exampleTopicId,
  moduleId: moduleIdSchema.parse('m_cap0d9fQ2xK4mZa7'),
  spec: 'Build a Huffman coder and justify each design choice.',
  drivingQuestionRef: 'How small can a message get...',
  purposeRef: 'build a compressor with an agent',
  submissions: [],
  status: 'not-started',
};

export const jobKindSchema = z.union([
  z.literal('generate-topic'),
  z.literal('author-module'),
  z.literal('capstone-spec'),
  z.literal('discontinuity-review'),
  z.literal('detour'),
  z.literal('extend'),
  z.literal('review-question'),
]);
export type JobKind = z.infer<typeof jobKindSchema>;
export const exampleJobKind: JobKind = 'author-module';

export const jobStatusSchema = z.union([
  z.literal('queued'),
  z.literal('running'),
  z.literal('succeeded'),
  z.literal('failed'),
  z.literal('cancelled'),
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;
export const exampleJobStatus: JobStatus = 'running';

export const errorCodeSchema = z.union([
  z.literal('validation'),
  z.literal('not-found'),
  z.literal('conflict'),
  z.literal('unauthorized'),
  z.literal('store-corrupt'),
  z.literal('store-key-missing'),
  z.literal('store-schema-ahead'),
  z.literal('cli-missing'),
  z.literal('cli-failed'),
  z.literal('sandbox-violation'),
  z.literal('timeout'),
  z.literal('cancelled'),
  z.literal('internal'),
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export const exampleErrorCode: ErrorCode = 'not-found';

export const appErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  correlationId: z.string(),
});
export type AppErrorShape = z.infer<typeof appErrorSchema>;
export const exampleAppError: AppErrorShape = {
  code: 'validation',
  message: 'Subject is required.',
  correlationId: 'c_18ab',
};

export const jobSchema = z.object({
  id: z.string(),
  kind: jobKindSchema,
  topicId: topicIdSchema,
  moduleId: moduleIdSchema.nullable(),
  status: jobStatusSchema,
  attempts: z.number(),
  startedAt: isoDateStringSchema.nullable(),
  finishedAt: isoDateStringSchema.nullable(),
  error: appErrorSchema.nullable(),
});
export type Job = z.infer<typeof jobSchema>;
export const exampleJob: Job = {
  id: 'j_1',
  kind: 'author-module',
  topicId: exampleTopicId,
  moduleId: exampleModuleId,
  status: 'running',
  attempts: 1,
  startedAt: isoDateStringSchema.parse('2026-08-22T09:20:00.000Z'),
  finishedAt: null,
  error: null,
};

/**
 * One piece of work the app has been asked to do, as the person waiting on it sees it.
 *
 * WHY it is not `Job`: a job row is an id, a kind and two foreign keys. What the learner
 * needs is which subject it belongs to, which lesson it is writing and when it was asked
 * for — and what they must NOT get is the correlation id or the error code, which say
 * nothing to them and are already in the log for whoever can read one.
 */
export const queueEntrySchema = z
  .object({
    id: z.string(),
    kind: jobKindSchema,
    status: jobStatusSchema,
    topicId: topicIdSchema,
    subject: z.string(),
    /** The lesson being written, when the work is about one lesson rather than a whole subject. */
    lessonTitle: z.string().nullable(),
    attempts: z.number(),
    queuedAt: isoDateStringSchema,
    startedAt: isoDateStringSchema.nullable(),
    finishedAt: isoDateStringSchema.nullable(),
    /** The learner-facing sentence from a failure, never its code or correlation id. */
    errorMessage: z.string().nullable(),
    /**
     * Whether this piece of work will produce the subject's outline, rather than write
     * lessons into one that already exists. WHY it is not the same as `kind`: a whole pass
     * is one job kind, and C4 chooses research or writing from whether an outline is in the
     * store. The queue named every one of them "planning", so a background pass that came
     * back for the lessons of an already-planned subject read as the app planning the same
     * curriculum over and over.
     */
    plansOutline: z.boolean(),
  })
  .strict();
export type QueueEntry = z.infer<typeof queueEntrySchema>;
export const exampleQueueEntry: QueueEntry = {
  id: 'j_1',
  kind: 'author-module',
  status: 'running',
  topicId: exampleTopicId,
  subject: 'Information theory',
  lessonTitle: 'Entropy as expected surprise',
  attempts: 1,
  queuedAt: isoDateStringSchema.parse('2026-08-22T09:19:00.000Z'),
  startedAt: isoDateStringSchema.parse('2026-08-22T09:20:00.000Z'),
  finishedAt: null,
  errorMessage: null,
  plansOutline: false,
};

export const queueViewSchema = z
  .object({
    /** Asked for and not yet picked up. */
    waiting: z.number(),
    /** Being worked on right now. */
    running: z.number(),
    entries: z.array(queueEntrySchema),
  })
  .strict();
export type QueueView = z.infer<typeof queueViewSchema>;
export const exampleQueueView: QueueView = {
  waiting: 0,
  running: 1,
  entries: [exampleQueueEntry],
};

export const generationProgressSchema = z.object({
  topicId: topicIdSchema,
  phase: z.union([z.literal('research'), z.literal('authoring'), z.literal('capstone'), z.literal('review'), z.literal('done')]),
  modulesTotal: z.number(),
  modulesDone: z.number(),
  currentModule: z.string().nullable(),
  lastTickAt: isoDateStringSchema,
});
export type GenerationProgress = z.infer<typeof generationProgressSchema>;
export const exampleGenerationProgress: GenerationProgress = {
  topicId: exampleTopicId,
  phase: 'authoring',
  modulesTotal: 10,
  modulesDone: 4,
  currentModule: 'Entropy as expected surprise',
  lastTickAt: isoDateStringSchema.parse('2026-08-22T09:31:12.000Z'),
};

export const cliSessionSpecSchema = z.object({
  id: sessionIdSchema,
  kind: z.union([jobKindSchema, z.literal('evaluate'), z.literal('ask'), z.literal('diagnostic')]),
  moduleDir: z.string(),
  prompt: z.string(),
  allowedTools: z.array(z.string()),
  timeoutMs: z.number(),
  maxTurns: z.number(),
  // WHY (warm-up): a chat turn used to be a brand-new CLI process handed the whole
  // transcript again. Naming a conversation lets the second and later turns resume the
  // first one instead, so only the learner's new message is sent. `resume` false means
  // "create this id"; true means "continue it".
  conversation: z.object({ uuid: z.string(), resume: z.boolean() }).optional(),
});
export type CliSessionSpec = z.infer<typeof cliSessionSpecSchema>;
export const exampleCliSessionSpec: CliSessionSpec = {
  id: exampleSessionId,
  kind: 'author-module',
  moduleDir: '<dataRoot>/topics/t_9fQ2xK4mZa71bC0d/modules/m_71bC0d9fQ2xK4mZa',
  prompt: '...',
  allowedTools: ['Read', 'Write', 'Edit'],
  timeoutMs: 600000,
  maxTurns: 40,
};

export const cliSessionResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    id: sessionIdSchema,
    output: z.unknown(),
    durationMs: z.number(),
    filesWritten: z.array(z.string()),
  }),
  z.object({
    ok: z.literal(false),
    id: sessionIdSchema,
    code: z.union([
      z.literal('timeout'),
      z.literal('nonzero-exit'),
      z.literal('sandbox-violation'),
      z.literal('context-exhausted'),
      z.literal('cancelled'),
      z.literal('cli-missing'),
    ]),
    message: z.string(),
    correlationId: z.string(),
    durationMs: z.number(),
  }),
]);
export type CliSessionResult = z.infer<typeof cliSessionResultSchema>;
export const exampleCliSessionResult: CliSessionResult = {
  ok: false,
  id: exampleSessionId,
  code: 'timeout',
  message: 'Module authoring session exceeded 600s.',
  correlationId: 'c_18ab',
  durationMs: 600001,
};

export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = { ok: false; error: AppErrorShape };
export type ApiResponse<T> = ApiOk<T> | ApiErr;

export const apiErrSchema = z.object({ ok: z.literal(false), error: appErrorSchema });
export const apiOkSchema = <T extends z.ZodTypeAny>(d: T) => z.object({ ok: z.literal(true), data: d });

export const exampleApiErr: ApiErr = {
  ok: false,
  error: exampleAppError,
};

/**
 * WHY: the app can drive its sessions with the Claude CLI, a model on this machine, or
 * any of the hosted APIs below. The provider is one config value rather than a scatter of
 * env checks, so every place that spawns, probes or explains a session reads the same
 * answer — and C2 turns exactly one of these into a wire format, so nothing above it
 * branches on which was chosen.
 *
 * WHY `openai-compatible` is a first-class member and not a footnote: the /v1/chat
 * completions shape is what LM Studio, vLLM, llama.cpp's server, OpenRouter, Groq,
 * Together and DeepSeek all speak. One adapter with an address the learner sets is the
 * whole long tail, and adding another vendor to it is a URL, not a release.
 */
export const providerKindSchema = z.union([
  z.literal('claude'),
  z.literal('ollama'),
  z.literal('llama'),
  z.literal('anthropic'),
  z.literal('openai'),
  z.literal('openai-compatible'),
  z.literal('gemini'),
  z.literal('mistral'),
]);
export type ProviderKind = z.infer<typeof providerKindSchema>;

/**
 * The provider's name as the learner chose it, for sentences they read.
 *
 * WHY it lives beside the schema rather than in the session runner: the browser needs
 * the same name for the banner, and it cannot import a module that spawns processes.
 */
export function providerName(provider: ProviderKind): string {
  if (provider === 'claude') return 'Claude';
  if (provider === 'ollama') return 'Ollama';
  if (provider === 'llama') return 'llama.cpp';
  if (provider === 'anthropic') return 'Anthropic';
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'gemini') return 'Gemini';
  if (provider === 'mistral') return 'Mistral';
  return 'That server';
}

/**
 * The providers whose sessions travel to somebody else's server over the internet, and
 * which therefore need an API key.
 *
 * WHY it is a list and not a predicate spelled out at each call site: "does this need a
 * key", "is this an egress destination" and "which env var names it" are the same
 * question asked three ways, and they have to agree.
 */
export const remoteProviderKinds = ['anthropic', 'openai', 'openai-compatible', 'gemini', 'mistral'] as const;
export type RemoteProviderKind = (typeof remoteProviderKinds)[number];

export function isRemoteProvider(kind: ProviderKind): kind is RemoteProviderKind {
  return (remoteProviderKinds as readonly string[]).includes(kind);
}

/**
 * Whether the learner's words actually leave this computer.
 *
 * WHY it is not the same question as `isRemoteProvider`: `openai-compatible` is the
 * adapter for OpenRouter AND for LM Studio on this laptop, and Settings tells the learner
 * which of those they are in. Answering "remote" for an address on 127.0.0.1 would be the
 * app claiming an egress it is not making — a lie in the direction that makes a private
 * setup look like a public one, which is the direction nobody checks.
 */
export function leavesThisMachine(kind: ProviderKind, baseUrl: string): boolean {
  // WHY the CLI is named before the remote check and not folded into it: `claude` signs
  // itself in to Anthropic and sends the prompt there, but it has no address in this
  // app's config — so falling through to the URL test below would answer "stays here" for
  // the one provider that has been sending words away since the first release.
  if (kind === 'claude') return true;
  if (!isRemoteProvider(kind)) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return !(host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost'));
  } catch {
    // WHY an unparseable address counts as leaving: the honest answer is "we cannot tell",
    // and the safe wording of that is the one that does not promise privacy.
    return true;
  }
}

/**
 * The `AppConfig` / `ChatModels` field each hosted provider owns.
 *
 * WHY it lives with the shapes and not beside one of its readers: the config layer, the
 * model resolver, the Settings screen and the availability probe all have to agree on
 * which section a provider reads, and a provider added to `ProviderKind` but missed in one
 * of them is a provider that silently dials somebody else's address.
 */
export const remoteSectionOf = {
  anthropic: 'anthropic',
  openai: 'openai',
  'openai-compatible': 'openaiCompatible',
  gemini: 'gemini',
  mistral: 'mistral',
} as const satisfies Record<RemoteProviderKind, string>;
export type RemoteSection = (typeof remoteSectionOf)[RemoteProviderKind];

/**
 * Where a hosted provider lives and which model it should run.
 *
 * WHY there is no `apiKey` here: this shape is written to `config.json`, and a key that
 * can be persisted eventually is. Keys are read from the environment (or `.env`) on every
 * use and held nowhere else — see `src/core/keys.ts`.
 */
export const remoteProviderConfigSchema = z.object({
  baseUrl: z.string(),
  model: z.string(),
});
export type RemoteProviderConfig = z.infer<typeof remoteProviderConfigSchema>;

export const ollamaConfigSchema = z.object({
  baseUrl: z.string(),
  model: z.string(),
});
export type OllamaConfig = z.infer<typeof ollamaConfigSchema>;

/**
 * WHY llama.cpp is configured by paths where Ollama is configured by a name: Ollama is
 * a daemon with its own model store, so naming a model is enough. llama-server is a
 * plain executable that serves ONE model file given to it on the command line, which is
 * also what lets the app start it — `binPath` and `modelPath` are exactly the two things
 * the spawn needs, and a `modelPath` of '' is the honest "not configured yet".
 */
export const llamaConfigSchema = z.object({
  baseUrl: z.string(),
  binPath: z.string(),
  modelPath: z.string(),
});
export type LlamaConfig = z.infer<typeof llamaConfigSchema>;

/**
 * The models a role other than lesson planning should use.
 *
 * WHY it is an override set rather than a second full provider block: the provider — and
 * for llama.cpp the binary that serves it — is one choice about this machine, not one per
 * kind of work. What genuinely differs between authoring a lesson and answering a learner
 * mid-conversation is only WHICH model runs: planning wants the strongest one available
 * and can take minutes; chat has a person waiting on it and is usually better served by a
 * smaller, faster one. So each field here is empty by default and empty means "the same
 * model lesson planning uses" — the app has one model until someone says otherwise.
 *
 * llama.cpp carries its own baseUrl because llama-server serves exactly ONE model file:
 * a second model means a second server on a second port, which the app starts the same
 * way it starts the first.
 */
export const chatModelsSchema = z.object({
  claude: z.string(),
  ollama: z.string(),
  llama: z.object({ baseUrl: z.string(), modelPath: z.string() }),
  // WHY every hosted provider gets its own entry rather than one shared string: the
  // model ids are not interchangeable, so a chat model named while OpenAI was selected
  // must not become the id dialled after a switch to Mistral.
  anthropic: z.string(),
  openai: z.string(),
  openaiCompatible: z.string(),
  gemini: z.string(),
  mistral: z.string(),
});
export type ChatModels = z.infer<typeof chatModelsSchema>;

export const appConfigSchema = z.object({
  dataRoot: z.string(),
  port: z.number(),
  provider: providerKindSchema,
  ollama: ollamaConfigSchema,
  llama: llamaConfigSchema,
  // WHY the hosted providers are five sections and not one: switching from OpenAI to
  // Mistral to compare them must not cost the learner the address and model they had
  // already set for the one they switched away from.
  anthropic: remoteProviderConfigSchema,
  openai: remoteProviderConfigSchema,
  openaiCompatible: remoteProviderConfigSchema,
  gemini: remoteProviderConfigSchema,
  mistral: remoteProviderConfigSchema,
  // WHY a limit at all: without one, a course that fans out its writing sessions opens a
  // dozen provider connections at once. It is a plain limit on how many sessions C2 will
  // have in flight — it authorises nothing, refuses nothing, and no session is ever failed
  // for it; work over the limit simply waits its turn.
  sessionConcurrency: z.number(),
  claudeBin: z.string(),
  // WHY '' rather than a pinned model id: with no `--model` the Claude CLI uses whatever
  // the learner's own installation defaults to, which is the right answer until they ask
  // for a different one. An id here is passed straight through as `--model`.
  claudeModel: z.string(),
  chatModels: chatModelsSchema,
  configWarnings: z.array(z.string()),
});
export type AppConfig = z.infer<typeof appConfigSchema>;
export const exampleAppConfig: AppConfig = {
  dataRoot: './data',
  port: 31544,
  provider: 'claude',
  ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'llama3.1' },
  llama: { baseUrl: 'http://127.0.0.1:18080', binPath: 'llama-server', modelPath: '' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  // WHY LM Studio's address is the default: the adapter covers every /v1 server, and the
  // one a learner is most likely to already have running is the one on their own machine.
  // An empty model is the honest state — the endpoint names its own models, and there is
  // no id this app could guess that would be right for all of them.
  openaiCompatible: { baseUrl: 'http://127.0.0.1:1234/v1', model: '' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-large-latest' },
  // WHY 16 and not a handful: every session here is one agent doing one self-contained
  // piece of work — writing a lesson, researching an outline, answering a turn — and they
  // do not talk to each other, so width costs nothing but provider load. At 2 a course was
  // written a pair of lessons at a time and a learner's turn queued behind the batch. The
  // real ceiling is the provider's rate limit, not this number; it stays a number so it can
  // be lowered on a machine or a plan that wants it lower.
  sessionConcurrency: 16,
  claudeBin: 'claude',
  claudeModel: '',
  // WHY port 18081 and not 18080: if a chat model IS chosen for llama.cpp it is a second
  // model file, and two llama-servers cannot share a port. The address is only dialled
  // once `modelPath` is non-empty, so an unused default costs nothing.
  chatModels: {
    claude: '',
    ollama: '',
    llama: { baseUrl: 'http://127.0.0.1:18081', modelPath: '' },
    anthropic: '',
    openai: '',
    openaiCompatible: '',
    gemini: '',
    mistral: '',
  },
  configWarnings: [],
};

export type AppPaths = {
  dataRoot: string;
  dbFile: string;
  /** The legacy, unversioned snapshot path. Read for recovery; never written. */
  dbPrev: string;
  /** Where the snapshot of a database at schema version `v` lives. */
  dbPrevForVersion: (v: number) => string;
  logsDir: string;
  topicsDir: string;
  moduleDir: (t: TopicId, m: ModuleId) => string;
  /** Where a topic's own source material lives, beside its module directories. */
  sourceDir: (t: TopicId) => string;
  /** Where an upload waits between "extract it" and "this is the subject it belongs to". */
  stagingDir: string;
  scrubSalt: string;
  sessionToken: string;
};

export const topicIntakeRequestSchema = z.object({
  subject: z
    .string()
    .trim()
    .min(1, { message: 'Subject is required.' })
    .max(200),
  level: levelSchema,
  levelDetail: z.string().max(500).optional(),
  purpose: z.string().trim().max(2000).default(''),
  runDiagnostic: z.boolean().default(false),
  confirmDuplicate: z.boolean().default(false),
  /** Uploads already extracted and waiting in staging, in the order the learner added them. */
  sourceIds: z.array(sourceIdSchema).max(10).default([]),
  /** A syllabus pasted straight into the form rather than uploaded. */
  pastedMaterial: z.string().max(MAX_SOURCE_CHARS).default(''),
});
export type TopicIntakeRequest = z.infer<typeof topicIntakeRequestSchema>;
export const exampleTopicIntakeRequest: TopicIntakeRequest = {
  subject: 'Information theory',
  level: 'intermediate',
  purpose: 'read Shannon and build a compressor with an agent',
  runDiagnostic: false,
  confirmDuplicate: false,
  sourceIds: [],
  pastedMaterial: '',
};


export const moduleAvailabilitySchema = z.object({
  moduleId: moduleIdSchema,
  state: moduleStateSchema,
  unmetPrereqs: z.array(moduleIdSchema),
});
export type ModuleAvailability = z.infer<typeof moduleAvailabilitySchema>;
export const exampleModuleAvailability: ModuleAvailability = {
  moduleId: exampleModuleId,
  state: 'available',
  unmetPrereqs: [],
};

export const entryDecisionSchema = z.object({
  enterable: z.literal(true),
  advisory: z
    .object({ unmetPrereqs: z.array(z.object({ id: moduleIdSchema, title: z.string() })) })
    .nullable(),
});
export type EntryDecision = z.infer<typeof entryDecisionSchema>;
export const exampleEntryDecision: EntryDecision = {
  enterable: true,
  advisory: { unmetPrereqs: [{ id: exampleModuleId, title: 'Probability refresher' }] },
};

export const insertionCheckSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: z.union([
      z.literal('would-create-cycle'),
      z.literal('prereq-of-existing'),
      z.literal('unknown-anchor'),
    ]),
    detail: z.string(),
  }),
]);
export type InsertionCheck = z.infer<typeof insertionCheckSchema>;
export const exampleInsertionCheck: InsertionCheck = {
  ok: false,
  reason: 'prereq-of-existing',
  detail: 'That lesson is already needed by a later lesson.',
};

export const capstoneRollupStatusSchema = z.union([
  z.literal('not-started'),
  z.literal('in-review'),
  z.literal('passed'),
  z.literal('n/a'),
]);
export type CapstoneRollupStatus = z.infer<typeof capstoneRollupStatusSchema>;
export const exampleCapstoneRollupStatus: CapstoneRollupStatus = 'not-started';

export const dashboardTopicSchema = z.object({
  id: topicIdSchema,
  subject: z.string(),
  status: topicStatusSchema,
  completedCount: z.number(),
  availableCount: z.number(),
  remainingCount: z.number(),
  capstone: capstoneRollupStatusSchema,
  needsReviewCount: z.number(),
  assistedPassCount: z.number(),
});
export type DashboardTopic = z.infer<typeof dashboardTopicSchema>;
export const exampleDashboardTopic: DashboardTopic = {
  id: exampleTopicId,
  subject: 'Bayesian statistics',
  status: 'ready',
  completedCount: 3,
  availableCount: 2,
  remainingCount: 7,
  capstone: 'not-started',
  needsReviewCount: 1,
  assistedPassCount: 1,
};

export const dashboardViewSchema = z.object({
  topics: z.array(dashboardTopicSchema),
  reviewsDue: z.number(),
  synthesisAvailable: z.boolean(),
});
export type DashboardView = z.infer<typeof dashboardViewSchema>;
export const exampleDashboardView: DashboardView = {
  topics: [exampleDashboardTopic],
  reviewsDue: 1,
  synthesisAvailable: false,
};

export const newReflectionSchema = z.object({
  topicId: topicIdSchema,
  moduleId: moduleIdSchema.nullable(),
  text: z.string(),
});
export type NewReflection = z.infer<typeof newReflectionSchema>;
export const exampleNewReflection: NewReflection = {
  topicId: exampleTopicId,
  moduleId: exampleModuleId,
  text: 'The prior is the belief you bring before the data arrives.',
};

export const selfVsEvaluatorRowSchema = z.object({
  turnLabel: z.string(),
  selfLabel: z.string(),
  evaluatorLabel: z.string(),
});
export type SelfVsEvaluatorRow = z.infer<typeof selfVsEvaluatorRowSchema>;
export const exampleSelfVsEvaluatorRow: SelfVsEvaluatorRow = {
  turnLabel: 'first answer',
  selfLabel: 'felt sure',
  evaluatorLabel: 'needed a nudge',
};

export const calibrationViewSchema = z.object({
  moduleId: moduleIdSchema,
  predictedLabel: z.string().nullable(),
  actualLabel: z.string(),
  selfVsEvaluator: z.array(selfVsEvaluatorRowSchema),
  note: z.string(),
});
export type CalibrationView = z.infer<typeof calibrationViewSchema>;
export const exampleCalibrationView: CalibrationView = {
  moduleId: exampleModuleId,
  predictedLabel: 'expected it to feel easy',
  actualLabel: 'took a couple of nudges',
  selfVsEvaluator: [exampleSelfVsEvaluatorRow],
  note: 'Here is how the module went.',
};

export const generationPhaseSchema = z.union([
  z.literal('research'),
  z.literal('authoring'),
  z.literal('capstone'),
  z.literal('review'),
]);
export type GenerationPhase = z.infer<typeof generationPhaseSchema>;
export const exampleGenerationPhase: GenerationPhase = 'research';

export const generationPlanSchema = z.object({
  estimatedModules: z.number().int().min(1),
  sessionCount: z.number().int().min(1),
  phases: z.array(generationPhaseSchema),
});
export type GenerationPlan = z.infer<typeof generationPlanSchema>;
export const exampleGenerationPlan: GenerationPlan = {
  estimatedModules: 10,
  sessionCount: 13,
  phases: ['research', 'authoring', 'capstone', 'review'],
};

export const detourRequestSchema = z.object({
  topicId: topicIdSchema,
  anchorModuleId: moduleIdSchema,
  question: z.string().trim().min(1).max(2000),
});
export type DetourRequest = z.infer<typeof detourRequestSchema>;
export const exampleDetourRequest: DetourRequest = {
  topicId: topicIdSchema.parse('t_9fQ2xK4mZa71bC0d'),
  anchorModuleId: moduleIdSchema.parse('m_71bC0d9fQ2xK4mZa'),
  question: 'How does this relate to Kolmogorov complexity?',
};

/**
 * A learner asking for the course they already have to go further.
 *
 * WHY the goal is free text and not a level: the thing being asked for is "sufficient
 * knowledge for the MCAT" or "enough to read the papers in my lab" — a destination in the
 * learner's own words, which is the same kind of thing F1 asks for as a purpose. A picker
 * of levels could not express either.
 */
export const extensionRequestSchema = z.object({
  topicId: topicIdSchema,
  goal: z.string().trim().min(1).max(2000),
});
export type ExtensionRequest = z.infer<typeof extensionRequestSchema>;
export const exampleExtensionRequest: ExtensionRequest = {
  topicId: topicIdSchema.parse('t_9fQ2xK4mZa71bC0d'),
  goal: 'Sufficient knowledge for the MCAT.',
};

/**
 * One goal a subject has already been carried to, and how many lessons that added.
 *
 * WHY it is kept and shown rather than just acted on: extending is a press that spends a
 * research session and then a course's worth of writing sessions, and with nothing on the
 * page saying it had happened, a learner whose extension was still being written had no way
 * to tell it from one they had never asked for. The list is what makes a second press a
 * decision rather than a guess.
 */
export const topicExtensionSchema = z.object({
  goal: z.string(),
  modulesAdded: z.number().int().min(0),
  createdAt: isoDateStringSchema,
});
export type TopicExtension = z.infer<typeof topicExtensionSchema>;
export const exampleTopicExtension: TopicExtension = {
  goal: 'Sufficient knowledge for the MCAT.',
  modulesAdded: 12,
  createdAt: isoDateStringSchema.parse('2026-09-01T10:00:00.000Z'),
};

export const graphValidationSchema = z.object({
  acyclic: z.boolean(),
  entryModules: z.array(moduleIdSchema),
  unreachable: z.array(moduleIdSchema),
  issues: z.array(topicNoteSchema),
});
export type GraphValidation = z.infer<typeof graphValidationSchema>;
export const exampleGraphValidation: GraphValidation = {
  acyclic: true,
  entryModules: [moduleIdSchema.parse('m_71bC0d9fQ2xK4mZa')],
  unreachable: [],
  issues: [],
};

export const MAX_LEARNER_MESSAGE_BYTES = 8 * 1024;

export const evalTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('module'), moduleId: moduleIdSchema }).strict(),
  z.object({ kind: z.literal('test-out'), moduleId: moduleIdSchema }).strict(),
  z.object({ kind: z.literal('review'), moduleId: moduleIdSchema }).strict(),
  z.object({ kind: z.literal('synthesis'), topicA: topicIdSchema, topicB: topicIdSchema }).strict(),
  z.object({ kind: z.literal('capstone'), topicId: topicIdSchema }).strict(),
]);
export type EvalTarget = z.infer<typeof evalTargetSchema>;
export const exampleEvalTarget: EvalTarget = {
  kind: 'synthesis',
  topicA: exampleTopicId,
  topicB: topicIdSchema.parse('t_0d9fQ2xK4mZa71bC'),
};

export const learnerMessageSchema = z
  .object({
    text: z.string().min(1),
    selfAssessment: selfAssessmentSchema.nullable(),
  })
  .strict()
  .refine((m) => Buffer.byteLength(m.text, 'utf8') <= MAX_LEARNER_MESSAGE_BYTES, {
    message: 'message too long',
    path: ['text'],
  });
export type LearnerMessage = z.infer<typeof learnerMessageSchema>;
export const exampleLearnerMessage: LearnerMessage = {
  text: 'Entropy is the expected number of bits you need, averaged over the distribution.',
  selfAssessment: { confidence: 3, critique: 'Shaky on the expectation step.' },
};

export const evalCompletionSchema = z
  .object({ moduleId: moduleIdSchema, unlocked: z.array(moduleIdSchema) })
  .strict();
export type EvalCompletion = z.infer<typeof evalCompletionSchema>;

export const evalTurnResultSchema = z
  .object({
    session: evalSessionSchema,
    evaluatorTurn: evalTurnSchema,
    verdict: evalVerdictSchema,
    completion: evalCompletionSchema.nullable(),
    remedialQueued: z.boolean(),
    // WHY (F10 AC): the calibration comparison is shown once, immediately after the
    // module is passed, so it rides back on the very turn that passed it.
    calibration: calibrationViewSchema.nullable(),
  })
  .strict();
export type EvalTurnResult = z.infer<typeof evalTurnResultSchema>;
export const exampleEvalTurnResult: EvalTurnResult = {
  session: exampleEvalSession,
  evaluatorTurn: exampleEvalTurn,
  verdict: exampleEvalVerdict,
  completion: { moduleId: exampleModuleId, unlocked: [] },
  remedialQueued: false,
  calibration: exampleCalibrationView,
};

export const angleLedgerSchema = z
  .object({ used: z.array(z.string()), available: z.array(z.string()) })
  .strict();
export type AngleLedger = z.infer<typeof angleLedgerSchema>;
export const exampleAngleLedger: AngleLedger = {
  used: ['compression'],
  available: ['gambling odds', 'twenty questions'],
};

/**
 * The FSRS-6 knobs C7 sets. `requestRetention` is the recall probability the interval
 * targets; it is a constant at FSRS's documented default and is a parameter only so tests
 * can vary it. It is deliberately not a setting — see `docs/spaced-repetition.md` §5.
 */
export const scheduleParamsSchema = z
  .object({
    requestRetention: z.number().gt(0).lte(1),
    maxIntervalDays: z.number().int().positive(),
    minIntervalDays: z.number().int().positive(),
  })
  .strict();
export type ScheduleParams = z.infer<typeof scheduleParamsSchema>;
export const exampleScheduleParams: ScheduleParams = {
  requestRetention: 0.9,
  maxIntervalDays: 180,
  minIntervalDays: 1,
};

export const mixPlanSchema = z
  .object({
    perTopic: z.array(z.object({ topicId: topicIdSchema, count: z.number() }).strict()),
    total: z.number(),
    fellBackToSingleTopic: z.boolean(),
  })
  .strict();
export type MixPlan = z.infer<typeof mixPlanSchema>;
export const exampleMixPlan: MixPlan = {
  perTopic: [
    { topicId: exampleTopicId, count: 4 },
    { topicId: topicIdSchema.parse('t_0d9fQ2xK4mZa71bC'), count: 4 },
  ],
  total: 8,
  fellBackToSingleTopic: false,
};

export const cliAvailabilitySchema = z
  // WHY `message`: which helper is missing depends on the provider, and the repair
  // instruction for it ("run `ollama pull ...`") is the only thing a learner can act on.
  // A bare `available: false` leaves every screen guessing, and they guessed "Claude".
  .object({ available: z.boolean(), version: z.string().nullable(), message: z.string().nullable() })
  .strict();
export type CliAvailability = z.infer<typeof cliAvailabilitySchema>;
export const exampleCliAvailability: CliAvailability = {
  available: true,
  version: '1.2.3',
  message: null,
};

/**
 * What the Settings screen needs to show and change about the provider: which one is
 * selected, where the local server is, which model it would use, and whether that
 * combination actually answers right now. `message` is the repair instruction when it
 * does not — "start ollama serve", "pull the model" — because a bare false is a dead end.
 */
export const providerViewSchema = z
  .object({
    provider: providerKindSchema,
    baseUrl: z.string(),
    model: z.string(),
    // WHY '' is a meaningful value and not null: the Settings field for it is a text box
    // that the learner empties to go back to one model for everything, and '' is what an
    // emptied text box sends. A null would need a second control to mean the same thing.
    chatModel: z.string(),
    chatBaseUrl: z.string(),
    available: z.boolean(),
    message: z.string().nullable(),
    /**
     * WHY the screen is told the NAME of the variable and never its value: a key is read
     * from the environment and lives nowhere else, so the only two things this app can
     * honestly say about it are which variable it looks in and whether that variable is
     * set. `null` means this provider needs no key at all.
     */
    keyEnvVar: z.string().nullable(),
    keySet: z.boolean(),
    /** Whether the prompt leaves this machine — what the "stays on this computer" line reads. */
    remote: z.boolean(),
  })
  .strict();
export type ProviderView = z.infer<typeof providerViewSchema>;
export const exampleProviderView: ProviderView = {
  provider: 'claude',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'llama3.1',
  chatModel: '',
  chatBaseUrl: 'http://127.0.0.1:18081',
  available: true,
  message: null,
  keyEnvVar: null,
  keySet: false,
  remote: true,
};

/**
 * The answer to "does this actually work" — one cheap call to the configured provider.
 *
 * WHY it is separate from `ProviderView`: opening Settings must not spend anything, and
 * for a hosted provider the only honest test is a real request. So the view reports what
 * is configured and this reports what happened when it was tried, on a press.
 */
export const providerTestResultSchema = z
  .object({ ok: z.boolean(), message: z.string() })
  .strict();
export type ProviderTestResult = z.infer<typeof providerTestResultSchema>;
export const exampleProviderTestResult: ProviderTestResult = {
  ok: true,
  message: 'Answered in 412ms as claude-opus-5.',
};

export const providerUpdateSchema = z
  .object({
    provider: providerKindSchema,
    baseUrl: z.string().trim().min(1).max(300).optional(),
    // WHY 300: for llama.cpp this field is a filesystem path to a .gguf, not a short
    // model name, and a path under a Windows user profile is easily past 120.
    model: z.string().trim().min(1).max(300).optional(),
    // WHY these two allow '' where `model` does not: an empty planning model is a broken
    // provider, but an empty chat model is the ordinary state — one model doing both jobs
    // — and clearing the box has to be able to say so.
    chatModel: z.string().trim().max(300).optional(),
    chatBaseUrl: z.string().trim().max(300).optional(),
  })
  .strict();
export type ProviderUpdate = z.infer<typeof providerUpdateSchema>;
export const exampleProviderUpdate: ProviderUpdate = { provider: 'ollama', model: 'llama3.1' };

export const healthViewSchema = z
  .object({
    appVersion: z.string(),
    schemaVersion: z.number(),
    cli: cliAvailabilitySchema,
    // WHY: with a local provider the "CLI available" line above is about Ollama, not
    // the Claude CLI. Naming the provider and its model is what makes that readable.
    provider: providerKindSchema,
    providerModel: z.string().nullable(),
    degradedTopicCount: z.number(),
    configWarnings: z.array(z.string()),
    dataRootDigest: z.string(),
  })
  .strict();
export type HealthView = z.infer<typeof healthViewSchema>;
export const exampleHealthView: HealthView = {
  appVersion: '0.1.0',
  schemaVersion: 3,
  cli: exampleCliAvailability,
  provider: 'claude',
  providerModel: null,
  degradedTopicCount: 0,
  configWarnings: [],
  dataRootDigest: '9f2c',
};

/**
 * WHY (H13): the recovery screen has to name the folder the learner must go and look in.
 * This is single-user local software, so the path is not a secret from its own user — but it
 * is deliberately NOT on HealthView, which is the broad diagnostic surface and must stay
 * path-free (see tests/api/health.test.ts). Only the recovery route serves it.
 */
/**
 * The per-launch token's header name. WHY (H10): this is one wire fact shared by the
 * client that sends it and the route that checks it, and it was written out twice — a
 * rename on either side would have compiled cleanly and failed every request at runtime.
 * It lives in C0 because both sides already import from here.
 */
export const TOKEN_HEADER = 'x-la-token';

export const recoveryInfoSchema = z
  .object({
    dataRoot: z.string(),
    dataFileName: z.string(),
    backupFileName: z.string(),
  })
  .strict();
export type RecoveryInfo = z.infer<typeof recoveryInfoSchema>;
export const exampleRecoveryInfo: RecoveryInfo = {
  dataRoot: '/home/learner/.learn-assistant',
  dataFileName: 'learn.db',
  backupFileName: 'learn.db.v6.prev',
};

export const sseEventNameSchema = z.union([z.literal('progress'), z.literal('error'), z.literal('done')]);
export type SseEventName = z.infer<typeof sseEventNameSchema>;

export const sseEventSchema = <T extends z.ZodTypeAny>(data: T): z.ZodObject<{ event: typeof sseEventNameSchema; data: T }, 'strict'> =>
  z.object({ event: sseEventNameSchema, data }).strict();
export type SseEvent<T> = { event: SseEventName; data: T };

export const progressSseEventSchema = sseEventSchema(generationProgressSchema);
export const exampleSseEvent: SseEvent<GenerationProgress> = {
  event: 'progress',
  data: exampleGenerationProgress,
};

export const degradedTopicSchema = z
  .object({
    degraded: z.literal(true),
    id: topicIdSchema,
    reason: z.string(),
    rawPreview: z.string(),
  })
  .strict();
export type DegradedTopicShape = z.infer<typeof degradedTopicSchema>;
export const exampleDegradedTopic: DegradedTopicShape = {
  degraded: true,
  id: exampleTopicId,
  reason: 'The saved record for this subject could not be read.',
  rawPreview: '{"id":"t_9fQ2xK4mZa71bC0d","subj',
};

export const topicOrDegradedSchema = z.union([topicSchema, degradedTopicSchema]);
export type TopicOrDegraded = z.infer<typeof topicOrDegradedSchema>;

export const topicDetailViewSchema = z.object({
  topic: topicOrDegradedSchema,
  graph: moduleGraphSchema,
  availability: z.array(moduleAvailabilitySchema),
  extensions: z.array(topicExtensionSchema),
});
export type TopicDetailView = z.infer<typeof topicDetailViewSchema>;

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'error'; error: AppErrorShape }
  | { status: 'ready'; data: T };

export const loadStateSchema = <S extends z.ZodTypeAny>(data: S) =>
  z.union([
    z.object({ status: z.literal('loading') }).strict(),
    z.object({ status: z.literal('empty') }).strict(),
    z.object({ status: z.literal('error'), error: appErrorSchema }).strict(),
    z.object({ status: z.literal('ready'), data }).strict(),
  ]);

export const exampleLoadState: LoadState<DashboardView> = {
  status: 'error',
  error: {
    code: 'store-corrupt',
    message: 'Your learning data could not be opened.',
    correlationId: 'c_18ab',
  },
};

export const pendingOpKindSchema = z.union([
  z.literal('send-message'),
  z.literal('complete-module'),
  z.literal('save-reflection'),
  z.literal('record-prediction'),
  z.literal('answer-practice'),
  z.literal('record-review'),
]);
export type PendingOpKind = z.infer<typeof pendingOpKindSchema>;

export type PendingOp = {
  id: string;
  kind: PendingOpKind;
  optimisticAppliedAt: number;
  rollback: () => void;
};

export const pendingOpSchema = z
  .object({
    id: z.string(),
    kind: pendingOpKindSchema,
    optimisticAppliedAt: z.number(),
    rollback: z.function().args().returns(z.void()),
  })
  .strict();

export const examplePendingOp: PendingOp = {
  id: 'op_1',
  kind: 'send-message',
  optimisticAppliedAt: 1755855000000,
  rollback: (): void => undefined,
};

export type AppStoreState = {
  dashboard: DashboardView | null;
  topic: { graph: ModuleGraph; availability: ModuleAvailability[] } | null;
  evalSession: EvalSession | null;
  pending: PendingOp[];
};

export const appStoreStateSchema = z
  .object({
    dashboard: dashboardViewSchema.nullable(),
    topic: z
      .object({ graph: moduleGraphSchema, availability: z.array(moduleAvailabilitySchema) })
      .strict()
      .nullable(),
    evalSession: evalSessionSchema.nullable(),
    pending: z.array(pendingOpSchema),
  })
  .strict();

export const exampleAppStoreState: AppStoreState = {
  dashboard: null,
  topic: null,
  evalSession: null,
  pending: [],
};

export const SHAPE_REGISTRY: { name: string; schema: z.ZodTypeAny; example: unknown }[] = [
  { name: 'ISODateString', schema: isoDateStringSchema, example: exampleISODateString },
  { name: 'TopicId', schema: topicIdSchema, example: exampleTopicId },
  { name: 'ModuleId', schema: moduleIdSchema, example: exampleModuleId },
  { name: 'SessionId', schema: sessionIdSchema, example: exampleSessionId },
  { name: 'Level', schema: levelSchema, example: exampleLevel },
  { name: 'TopicStatus', schema: topicStatusSchema, example: exampleTopicStatus },
  { name: 'ModuleState', schema: moduleStateSchema, example: exampleModuleState },
  { name: 'Topic', schema: topicSchema, example: exampleTopic },
  { name: 'TopicNote', schema: topicNoteSchema, example: exampleTopicNote },
  { name: 'DiagnosticTranscript', schema: diagnosticTranscriptSchema, example: exampleDiagnosticTranscript },
  { name: 'DiagnosticTurnResult', schema: diagnosticTurnResultSchema, example: exampleDiagnosticTurnResult },
  { name: 'SourceId', schema: sourceIdSchema, example: exampleSourceId },
  { name: 'SourceKind', schema: sourceKindSchema, example: exampleSourceKind },
  { name: 'SourceUnit', schema: sourceUnitSchema, example: exampleSourceUnit },
  { name: 'SourceDocument', schema: sourceDocumentSchema, example: exampleSourceDocument },
  { name: 'StagedSource', schema: stagedSourceSchema, example: exampleStagedSource },
  { name: 'ModuleNode', schema: moduleNodeSchema, example: exampleModuleNode },
  { name: 'PrereqEdge', schema: prereqEdgeSchema, example: examplePrereqEdge },
  { name: 'ModuleGraph', schema: moduleGraphSchema, example: exampleModuleGraph },
  { name: 'Explanation', schema: explanationSchema, example: exampleExplanation },
  { name: 'Visualization', schema: visualizationSchema, example: exampleVisualization },
  { name: 'LessonBlock', schema: lessonBlockSchema, example: exampleLessonBlock },
  { name: 'WarmUp', schema: warmUpSchema, example: exampleWarmUp },
  { name: 'WarmUpRecord', schema: warmUpRecordSchema, example: exampleWarmUpRecord },
  { name: 'LessonQuestion', schema: lessonQuestionSchema, example: exampleLessonQuestion },
  { name: 'ModuleContent', schema: moduleContentSchema, example: exampleModuleContent },
  { name: 'EvalScript', schema: evalScriptSchema, example: exampleEvalScript },
  { name: 'TeachBackMisconception', schema: teachBackMisconceptionSchema, example: exampleTeachBackMisconception },
  { name: 'AssistLevel', schema: assistLevelSchema, example: exampleAssistLevel },
  { name: 'EvalTurn', schema: evalTurnSchema, example: exampleEvalTurn },
  { name: 'SelfAssessment', schema: selfAssessmentSchema, example: exampleSelfAssessment },
  { name: 'EvalVerdict', schema: evalVerdictSchema, example: exampleEvalVerdict },
  { name: 'EvalSession', schema: evalSessionSchema, example: exampleEvalSession },
  { name: 'EvalTarget', schema: evalTargetSchema, example: exampleEvalTarget },
  { name: 'LearnerMessage', schema: learnerMessageSchema, example: exampleLearnerMessage },
  { name: 'EvalTurnResult', schema: evalTurnResultSchema, example: exampleEvalTurnResult },
  { name: 'AngleLedger', schema: angleLedgerSchema, example: exampleAngleLedger },
  { name: 'ReviewMemory', schema: reviewMemorySchema, example: exampleReviewMemory },
  { name: 'ReviewItem', schema: reviewItemSchema, example: exampleReviewItem },
  { name: 'ReviewCue', schema: reviewCueSchema, example: exampleReviewCue },
  { name: 'PracticeSession', schema: practiceSessionSchema, example: examplePracticeSession },
  { name: 'PracticeQuestion', schema: practiceQuestionSchema, example: examplePracticeQuestion },
  { name: 'ScheduleParams', schema: scheduleParamsSchema, example: exampleScheduleParams },
  { name: 'MixPlan', schema: mixPlanSchema, example: exampleMixPlan },
  { name: 'Prediction', schema: predictionSchema, example: examplePrediction },
  { name: 'Calibration', schema: calibrationSchema, example: exampleCalibration },
  { name: 'Reflection', schema: reflectionSchema, example: exampleReflection },
  { name: 'CardDeck', schema: cardDeckSchema, example: exampleCardDeck },
  { name: 'Card', schema: cardSchema, example: exampleCard },
  { name: 'CardView', schema: cardViewSchema, example: exampleCardView },
  { name: 'DeckSummary', schema: deckSummarySchema, example: exampleDeckSummary },
  { name: 'CardGrade', schema: cardGradeSchema, example: exampleCardGrade },
  { name: 'CardPack', schema: cardPackSchema, example: exampleCardPack },
  { name: 'CardPackImport', schema: cardPackImportSchema, example: exampleCardPackImport },
  { name: 'NewCard', schema: newCardSchema, example: exampleNewCard },
  { name: 'CardImport', schema: cardImportSchema, example: exampleCardImport },
  { name: 'Capstone', schema: capstoneSchema, example: exampleCapstone },
  { name: 'CapstoneSubmission', schema: capstoneSubmissionSchema, example: exampleCapstoneSubmission },
  { name: 'Job', schema: jobSchema, example: exampleJob },
  { name: 'JobKind', schema: jobKindSchema, example: exampleJobKind },
  { name: 'JobStatus', schema: jobStatusSchema, example: exampleJobStatus },
  { name: 'QueueEntry', schema: queueEntrySchema, example: exampleQueueEntry },
  { name: 'QueueView', schema: queueViewSchema, example: exampleQueueView },
  { name: 'GenerationProgress', schema: generationProgressSchema, example: exampleGenerationProgress },
  { name: 'CliAvailability', schema: cliAvailabilitySchema, example: exampleCliAvailability },
  { name: 'HealthView', schema: healthViewSchema, example: exampleHealthView },
  { name: 'ChatModels', schema: chatModelsSchema, example: exampleAppConfig.chatModels },
  { name: 'ProviderView', schema: providerViewSchema, example: exampleProviderView },
  { name: 'ProviderTestResult', schema: providerTestResultSchema, example: exampleProviderTestResult },
  { name: 'ProviderUpdate', schema: providerUpdateSchema, example: exampleProviderUpdate },
  { name: 'RecoveryInfo', schema: recoveryInfoSchema, example: exampleRecoveryInfo },
  { name: 'DegradedTopic', schema: degradedTopicSchema, example: exampleDegradedTopic },
  { name: 'LoadState', schema: loadStateSchema(dashboardViewSchema), example: exampleLoadState },
  { name: 'PendingOp', schema: pendingOpSchema, example: examplePendingOp },
  { name: 'AppStoreState', schema: appStoreStateSchema, example: exampleAppStoreState },
  { name: 'SseEvent', schema: progressSseEventSchema, example: exampleSseEvent },
  { name: 'CliSessionSpec', schema: cliSessionSpecSchema, example: exampleCliSessionSpec },
  { name: 'CliSessionResult', schema: cliSessionResultSchema, example: exampleCliSessionResult },
  { name: 'ErrorCode', schema: errorCodeSchema, example: exampleErrorCode },
  { name: 'AppError', schema: appErrorSchema, example: exampleAppError },
  { name: 'ApiErr', schema: apiErrSchema, example: exampleApiErr },
  { name: 'AppConfig', schema: appConfigSchema, example: exampleAppConfig },
  { name: 'TopicIntakeRequest', schema: topicIntakeRequestSchema, example: exampleTopicIntakeRequest },
  { name: 'ModuleAvailability', schema: moduleAvailabilitySchema, example: exampleModuleAvailability },
  { name: 'EntryDecision', schema: entryDecisionSchema, example: exampleEntryDecision },
  { name: 'InsertionCheck', schema: insertionCheckSchema, example: exampleInsertionCheck },
  { name: 'CapstoneRollupStatus', schema: capstoneRollupStatusSchema, example: exampleCapstoneRollupStatus },
  { name: 'DashboardTopic', schema: dashboardTopicSchema, example: exampleDashboardTopic },
  { name: 'DashboardView', schema: dashboardViewSchema, example: exampleDashboardView },
  { name: 'NewReflection', schema: newReflectionSchema, example: exampleNewReflection },
  { name: 'SelfVsEvaluatorRow', schema: selfVsEvaluatorRowSchema, example: exampleSelfVsEvaluatorRow },
  { name: 'CalibrationView', schema: calibrationViewSchema, example: exampleCalibrationView },
  { name: 'GenerationPhase', schema: generationPhaseSchema, example: exampleGenerationPhase },
  { name: 'GenerationPlan', schema: generationPlanSchema, example: exampleGenerationPlan },
  { name: 'DetourRequest', schema: detourRequestSchema, example: exampleDetourRequest },
  { name: 'ExtensionRequest', schema: extensionRequestSchema, example: exampleExtensionRequest },
  { name: 'TopicExtension', schema: topicExtensionSchema, example: exampleTopicExtension },
  { name: 'GraphValidation', schema: graphValidationSchema, example: exampleGraphValidation },
];
