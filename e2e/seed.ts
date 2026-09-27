// FRACTAL: covers project | type e2e | scope harness
/**
 * Builds the data root the Playwright suite runs against, and writes the ids it minted
 * to `e2e/.seed.json` so the specs can address them.
 *
 * WHY: every flow below the dashboard needs a subject that already has lessons in it,
 * and half of them need a lesson that is already finished (reviews, practice, linking
 * two subjects). Driving all of that through the UI first would make one spec's failure
 * take out nine others, so the starting state is written straight into the store and
 * every spec then exercises only its own feature.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import {
  isoDateStringSchema,
  moduleIdSchema,
  sessionIdSchema,
  type ISODateString,
  type ModuleContent,
  type ModuleGraph,
  type ModuleId,
  type ModuleNode,
  type ReviewItem,
  type TopicId,
} from '../src/shapes';
import { closeStore, openStore } from '../src/store/open';
import { setTopicStatus } from '../src/orchestrator/topic-state';

export const SEED_FILE = path.resolve('e2e/.seed.json');

export const SUBJECT_A = 'Information theory';
export const SUBJECT_B = 'Bayesian inference';

/** Lesson 1 of subject A: finished, and due for review — F7, F8 and F10 all read it. */
export const A_DONE = moduleIdSchema.parse('m_a000000000000001');
/** Two lessons open side by side, so F3's "several open, pick one" case is real. */
export const A_OPEN_1 = moduleIdSchema.parse('m_a000000000000002');
export const A_OPEN_2 = moduleIdSchema.parse('m_a000000000000003');
/**
 * An entry module with no prerequisites and no edges, reserved for specs that need an
 * untouched open lesson late in the run.
 *
 * WHY: the suite shares one data root and runs in file order, so a lesson another spec
 * finishes is no longer open by the time a later spec looks for one. This one is
 * addressed by id and completed by nobody.
 */
export const A_SPARE = moduleIdSchema.parse('m_a000000000000005');
/** Behind a prerequisite — the "suggested for later" card, and F12's detour anchor. */
export const A_LATER = moduleIdSchema.parse('m_a000000000000004');
export const A_CAPSTONE = moduleIdSchema.parse('m_a00000000000000c');
export const B_DONE = moduleIdSchema.parse('m_b000000000000001');
export const B_OPEN = moduleIdSchema.parse('m_b000000000000002');

export type SeedIds = { topicA: TopicId; topicB: TopicId };

export function readSeed(): SeedIds {
  return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) as SeedIds;
}

function iso(offsetMs: number): ISODateString {
  return isoDateStringSchema.parse(new Date(Date.UTC(2026, 0, 1) + offsetMs).toISOString());
}

/** The lesson whose body carries the deliberately over-wide display equation. */
export const WIDE_MATH_LESSON = 'Reading a probability table';

/** Wide on purpose: one aligned row of terms that cannot fit in a 940px column. */
export const WIDE_MATH_MARKDOWN = [
  'And the whole thing written out at once:',
  '',
  String.raw`$$\begin{aligned} H(X_1, X_2, \ldots, X_n) &= -\sum_{x_1} \sum_{x_2} \cdots \sum_{x_n} p(x_1, x_2, \ldots, x_n) \log_2 p(x_1, x_2, \ldots, x_n) = \sum_{i=1}^{n} H(X_i \mid X_1, \ldots, X_{i-1}) \le \sum_{i=1}^{n} H(X_i) \end{aligned}$$`,
].join('\n');

function content(title: string, goal: string): ModuleContent {
  return {
    learningGoals: [goal, `Explain ${title.toLowerCase()} in your own words`],
    warmUp: {
      prompt: `Before you read: what do you already think ${title.toLowerCase()} means?`,
      expectedStruggle: 'Reaching for a definition instead of an example.',
    },
    explanation: {
      kind: 'text',
      markdown: `## ${title}\n\nThis is the seeded explanation for **${title}**. It is deliberately short.`,
    },
    // The interleaved body (F3): one of each interactive kind, so the E2E walks the real
    // controls rather than a prose-only lesson that never had any.
    blocks: [
      { kind: 'prose', markdown: `The seeded body for **${title}** opens here.` },
      // One lesson carries a display equation far wider than the 940px content column,
      // so the suite has a real case for "wide maths must not scroll the whole page".
      ...(title === WIDE_MATH_LESSON
        ? [{ kind: 'prose' as const, markdown: WIDE_MATH_MARKDOWN }]
        : []),
      {
        kind: 'figure',
        svg: '<svg viewBox="0 0 40 20"><line x1="0" y1="10" x2="40" y2="10" stroke="currentColor" /></svg>',
        caption: `A seeded diagram of ${title.toLowerCase()}.`,
      },
      {
        kind: 'check',
        question: `Is ${title.toLowerCase()} a definition or an example?`,
        options: ['A definition to recite', 'Something you can point at'],
        answerIndex: 1,
        whyRight: 'Pointing at one is what shows you have it.',
        whyWrong: 'Reciting the words is the struggle this lesson expects.',
      },
      { kind: 'prose', markdown: 'And it continues after the check.' },
      {
        kind: 'reveal',
        prompt: `Before you look: name one case ${title.toLowerCase()} does not cover.`,
        answer: 'Any case where the quantity is already known.',
      },
      {
        kind: 'steps',
        title: `Working through ${title.toLowerCase()}`,
        steps: [
          { label: 'Start with one case', markdown: 'Take a single outcome and name it.' },
          { label: 'Then average', markdown: 'Do that for every outcome and weigh them.' },
        ],
      },
      // A plot the learner drives (F3). Seeded alongside the legacy stepper so the suite
      // covers both the kind lessons are written with now and the kind already stored.
      {
        kind: 'plot',
        title: `How ${title.toLowerCase()} responds to its parameter`,
        caption: 'Drag the rate: the curve steepens long before it gets taller.',
        xLabel: 't',
        yLabel: 'N',
        xMin: 0,
        xMax: 5,
        params: [{ name: 'k', label: 'Rate', min: 0, max: 3, step: 0.5, value: 1 }],
        curves: [{ label: 'exp(k t)', expression: 'exp(k * x)' }],
      },
      // A lesson-written visualization (F3). Besides doing something when clicked, it tries
      // every way out of its sandbox and writes down what happened, so the E2E can check
      // from the outside that model-written script ran AND stayed contained.
      {
        kind: 'interactive',
        title: `Halving ${title.toLowerCase()}`,
        caption: 'Ask until one is left.',
        height: 160,
        html: [
          '<p id="left">16 left</p><button id="ask">Ask a question</button>',
          '<p id="parent-read"></p><p id="storage"></p><p id="network"></p>',
          '<script>',
          'let n = 16;',
          'ask.onclick = () => { n = Math.max(1, n / 2); left.textContent = n + " left"; };',
          'try { parent.document.title; document.getElementById("parent-read").textContent = "parent: READ"; }',
          'catch (e) { document.getElementById("parent-read").textContent = "parent: blocked"; }',
          'try { localStorage.length; storage.textContent = "storage: READ"; }',
          'catch (e) { storage.textContent = "storage: blocked"; }',
          'fetch("/api/health").then(() => { network.textContent = "network: REACHED"; },',
          '  () => { network.textContent = "network: blocked"; });',
          '</script>',
        ].join('\n'),
      },
    ],
    // The pack of flat facts the authoring session proposed (F14): offered with the
    // lesson, added to the learner's cards only if they press the button.
    cardPack: {
      name: `${title}: the words`,
      why: 'Nothing derives these names — they are worth knowing by heart.',
      cards: [
        { front: title, back: `The seeded back of ${title.toLowerCase()}.` },
        { front: `${title} (symbol)`, back: '$H(X)$' },
      ],
    },
    visualization: { kind: 'none' },
    evalScript: {
      objectives: [goal],
      seedQuestions: [`In your own words, what is ${title.toLowerCase()}?`],
      angles: ['an example', 'a counter-example'],
      misconceptions: [],
      passCriteria: [`Explains ${title.toLowerCase()} without reciting the definition`],
    },
    authoredAt: iso(0),
    authoredBySession: sessionIdSchema.parse('s_seedseedseedseed'),
  };
}

function node(
  id: ModuleId,
  topicId: TopicId,
  title: string,
  ordinal: number,
  state: ModuleNode['state'],
  kind: ModuleNode['kind'] = 'module',
): ModuleNode {
  return {
    id,
    topicId,
    title,
    ordinal,
    kind,
    testOutEligible: ordinal === 2,
    estimatedMinutes: 15 + ordinal,
    state,
    // WHY the capstone carries a written brief: the tutor proposes the project (F13), and a
    // project with no brief cannot be opened for review at all.
    content:
      kind === 'capstone'
        ? {
            ...content(title, `Use ${title.toLowerCase()} deliberately`),
            explanation: {
              kind: 'text',
              markdown:
                'Compress the 12 KB log excerpt below with a coder you build yourself, report the ratio you reach, and justify every design choice against the lessons.',
            },
          }
        : content(title, `Use ${title.toLowerCase()} deliberately`),
  };
}

function graphA(topicId: TopicId): ModuleGraph {
  const nodes = [
    node(A_DONE, topicId, 'Counting outcomes', 1, 'completed'),
    node(A_OPEN_1, topicId, 'Entropy as expected surprise', 2, 'available'),
    node(A_OPEN_2, topicId, 'Codes and code lengths', 3, 'available'),
    node(A_LATER, topicId, 'Channel capacity', 4, 'not-yet-recommended'),
    node(A_SPARE, topicId, 'Reading a probability table', 5, 'available'),
    node(A_CAPSTONE, topicId, 'Compress a real file', 6, 'available', 'capstone'),
  ];
  return {
    topicId,
    nodes,
    edges: [
      { from: A_DONE, to: A_OPEN_1 },
      { from: A_DONE, to: A_OPEN_2 },
      { from: A_OPEN_1, to: A_LATER },
      { from: A_OPEN_2, to: A_CAPSTONE },
    ],
    entryModules: [A_DONE, A_SPARE],
  };
}

function graphB(topicId: TopicId): ModuleGraph {
  const nodes = [
    node(B_DONE, topicId, 'Priors and posteriors', 1, 'completed'),
    node(B_OPEN, topicId, 'Updating on evidence', 2, 'available'),
  ];
  return { topicId, nodes, edges: [{ from: B_DONE, to: B_OPEN }], entryModules: [B_DONE] };
}

function dueItem(moduleId: ModuleId): ReviewItem {
  return {
    moduleId,
    dueAt: iso(0),
    intervalDays: 1,
    memory: { stability: 3, difficulty: 2.1181, reps: 1, lastReviewedAt: null },
    lapses: 0,
    lastAssistLevel: 0,
    flaggedNeedsReview: false,
  };
}

export function seedDataRoot(dataRoot: string): SeedIds {
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(dataRoot, 'topics'), { recursive: true });

  const store = openStore(dataRoot);
  let ids: SeedIds;
  try {
    const a = store.topics.create({
      subject: SUBJECT_A,
      level: 'beginner',
      levelDetail: undefined,
      purpose: 'Understand information theory well enough to explain it',
      diagnostic: null,
    });
    const b = store.topics.create({
      subject: SUBJECT_B,
      level: 'intermediate',
      levelDetail: undefined,
      purpose: 'Update beliefs on evidence without reaching for a formula',
      diagnostic: null,
    });
    ids = { topicA: a.id, topicB: b.id };

    store.modules.upsertGraph(graphA(a.id));
    store.modules.upsertGraph(graphB(b.id));
    store.reviews.upsert(dueItem(A_DONE));
    store.reviews.upsert(dueItem(B_DONE));

    for (const [topicId, moduleIds] of [
      [a.id, [A_DONE, A_OPEN_1, A_OPEN_2, A_LATER, A_SPARE, A_CAPSTONE]],
      [b.id, [B_DONE, B_OPEN]],
    ] as [TopicId, ModuleId[]][]) {
      for (const moduleId of moduleIds) {
        fs.mkdirSync(path.join(dataRoot, 'topics', topicId, 'modules', moduleId), { recursive: true });
      }
    }
  } finally {
    closeStore(dataRoot);
  }

  // WHY this is written directly rather than through the repo: `topics.create` mints a
  // subject in 'queued', which is the honest first-run state but not the state these
  // specs are about. A topic whose lessons already exist is 'ready', and several
  // features are correctly refused on a queued topic — a detour, for one. There is no
  // repo method to move the status because in the running app only the generation
  // orchestrator may, so the fixture sets the finished state it is standing in for.
  const db = new Database(path.join(dataRoot, 'learn.db'));
  try {
    const setReady = db.prepare('UPDATE topics SET status = ?, driving_question = ? WHERE id = ?');
    setReady.run('ready', 'How few bits can carry this message?', ids.topicA);
    setReady.run('ready', 'What should this evidence do to my belief?', ids.topicB);
  } finally {
    db.close();
  }

  // WHY both: the SQL column above feeds the dashboard rollup, while the generation
  // orchestrator keeps its own status in a sidecar (orchestration.json) that defaults
  // to 'queued' when absent. A detour is refused on a queued topic, so the fixture has
  // to state the finished status in both places or the two disagree.
  setTopicStatus(dataRoot, ids.topicA, 'ready');
  setTopicStatus(dataRoot, ids.topicB, 'ready');

  fs.mkdirSync(path.dirname(SEED_FILE), { recursive: true });
  fs.writeFileSync(SEED_FILE, `${JSON.stringify(ids, null, 2)}\n`, 'utf8');
  return ids;
}

/**
 * A subject carrying this word makes the fake CLI exit non-zero, so a spec can drive a
 * generation that genuinely fails rather than waiting on one that happens to.
 * Kept in step with FAIL_SENTINEL in e2e/fixtures/fake-claude.mjs.
 */
export const FAIL_SENTINEL = 'E2E-FORCE-FAILURE';

/**
 * A subject carrying this word makes the fake CLI answer slowly, so a spec can watch a
 * run progress instead of finding it already over.
 * Kept in step with SLOW_SENTINEL in e2e/fixtures/fake-claude.mjs.
 */
export const SLOW_SENTINEL = 'E2E-SLOW-RUN';
