#!/usr/bin/env node
// FRACTAL: implements F6 | component C2
// A deterministic, out-of-process twin of src/cli/transport.fake.ts used by the
// Playwright suite. It reads a prompt on stdin, looks for the "KIND: <kind>"
// line that src/cli/prompt.ts always emits as its first line, and prints one
// JSON object on stdout that validates against the matching zod schema in
// src/shapes.ts. --version support backs the availability probe.

import os from 'node:os';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

/** Kept in step with FAIL_SENTINEL in e2e/seed.ts. */
const FAIL_SENTINEL = 'E2E-FORCE-FAILURE';
/**
 * A subject carrying this word answers slowly. Kept in step with SLOW_SENTINEL in
 * e2e/seed.ts.
 *
 * WHY the suite needs a slow run at all: this fixture answers in milliseconds, so a whole
 * course is written between two frames and a spec asking "does the count climb while the
 * learner watches?" has nothing to watch. One subject asks for a pace a person could see;
 * every other spec keeps the fast one.
 */
const SLOW_SENTINEL = 'E2E-SLOW-RUN';
const SLOW_MS = 400;
const FAKE_TOPIC_ID = 't_AAAAAAAAAAAAAAAA';
const FAKE_MODULE_ID = 'm_AAAAAAAAAAAAAAAA';
const FAKE_SESSION_ID = 's_AAAAAAAAAAAAAAAA';
const FAKE_ISO = '2026-08-22T09:20:00.000Z';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    if (process.stdin.isTTY) resolve('');
  });
}

// WHY this fixture has a memory at all: a chat turn after the first RESUMES a CLI
// conversation, so the app deliberately sends only the learner's new message and lets the
// CLI supply the lesson and the pass criteria from its own transcript. A twin with no
// transcript would answer those turns without the criteria it is meant to be judging
// against — and would report an E2E failure that only its own amnesia caused. One file per
// conversation id, holding the little this fixture actually reads back, is that transcript.
function conversationFile(uuid) {
  return path.join(os.tmpdir(), `fake-claude-${uuid.replace(/[^A-Za-z0-9-]/g, '')}.json`);
}

function conversationOf(argv) {
  const resume = argv.indexOf('--resume');
  if (resume >= 0) return { uuid: argv[resume + 1] ?? null, resumed: true };
  const opened = argv.indexOf('--session-id');
  if (opened >= 0) return { uuid: argv[opened + 1] ?? null, resumed: false };
  return { uuid: null, resumed: false };
}

function recallPrompt(conversation, prompt) {
  if (conversation.uuid === null) return prompt;
  const file = conversationFile(conversation.uuid);
  if (!conversation.resumed) {
    writeFileSync(file, JSON.stringify({ opening: prompt }), 'utf8');
    return prompt;
  }
  try {
    const { opening } = JSON.parse(readFileSync(file, 'utf8'));
    return `${opening}\n${prompt}`;
  } catch {
    // The app treats a resume it cannot honour as a lost conversation and re-opens with
    // the full brief, so failing here is the behaviour under test, not a fixture bug.
    process.stderr.write(`fake-claude: no transcript for ${conversation.uuid}\n`);
    process.exitCode = 1;
    return null;
  }
}

function extractKind(prompt) {
  const firstLine = prompt.split('\n')[0] ?? '';
  const match = /^KIND:\s*(.+)$/.exec(firstLine.trim());
  return match ? match[1].trim() : 'author-module';
}

function moduleContent() {
  return {
    learningGoals: ['State entropy as expected surprise'],
    warmUp: {
      prompt: 'Before reading: how many yes/no questions pin down one of 8 equally likely outcomes? Why?',
      expectedStruggle: 'Answering 8 rather than 3.',
    },
    explanation: { kind: 'text', markdown: 'Entropy is the expected number of bits of surprise.' },
    blocks: [
      { kind: 'prose', markdown: 'A fair coin costs one question to pin down.' },
      {
        kind: 'figure',
        svg: '<svg viewBox="0 0 40 20"><line x1="0" y1="10" x2="40" y2="10" stroke="currentColor" /></svg>',
        caption: 'One halving per question.',
      },
      {
        kind: 'check',
        question: 'How many yes/no questions pin down one of $8$ outcomes?',
        options: ['$8$', '$3$'],
        answerIndex: 1,
        whyRight: 'Each question halves the field, and $\log_2 8 = 3$.',
        whyWrong: 'That counts the outcomes rather than the halvings.',
      },
      { kind: 'prose', markdown: 'Weighted by probability, that count is the entropy.' },
      {
        kind: 'reveal',
        prompt: 'What is the entropy of a coin that always lands heads?',
        answer: 'Zero — there is nothing left to ask.',
      },
      {
        kind: 'steps',
        title: 'Building up $H(X)$',
        steps: [
          { label: 'Surprise of one outcome', markdown: 'Write $\log_2(1/p)$ for a single outcome.' },
          { label: 'Average it', markdown: 'Weight each surprise by its own $p$ and add them up.' },
        ],
      },
    ],
    visualization: { kind: 'none' },
    evalScript: {
      objectives: ['Distinguish entropy from information content'],
      seedQuestions: ['Why is a fair coin one bit?'],
      angles: ['compression', 'gambling odds'],
      misconceptions: [],
      passCriteria: ['Explains why entropy is an expectation, not a per-symbol constant'],
    },
    authoredAt: FAKE_ISO,
    authoredBySession: FAKE_SESSION_ID,
  };
}

function moduleGraph() {
  return {
    topicId: FAKE_TOPIC_ID,
    nodes: [
      {
        id: FAKE_MODULE_ID,
        topicId: FAKE_TOPIC_ID,
        title: 'Entropy as expected surprise',
        ordinal: 1,
        kind: 'module',
        testOutEligible: false,
        estimatedMinutes: 20,
        state: 'available',
        content: null,
      },
    ],
    edges: [],
    entryModules: [FAKE_MODULE_ID],
  };
}

// The outline an EXTENSION pass comes back with. WHY the titles differ from moduleGraph's:
// an extension is deduped against the lessons the course already has, so a fixture that
// proposed the same lesson again would test the dedupe and nothing else — and the spec could
// not tell a landed extension from a course that never grew.
function extensionGraph() {
  return {
    nodes: [
      { title: 'Amino acids and the peptide bond', objectives: ['Name the twenty and how they join.'] },
      { title: 'Enzyme kinetics under saturation', objectives: ['Read a Michaelis-Menten curve.'] },
      { title: 'Reading a passage-based question', objectives: ['Answer from the passage, not from memory.'] },
    ],
    edges: [{ fromIndex: 0, toIndex: 1 }],
  };
}

function capstone() {
  return {
    topicId: FAKE_TOPIC_ID,
    moduleId: FAKE_MODULE_ID,
    spec: 'Build a Huffman coder and justify each design choice.',
    drivingQuestionRef: 'How small can a message get?',
    purposeRef: 'build a compressor',
    submissions: [],
    status: 'not-started',
  };
}

function discontinuityReview() {
  return {
    kind: 'discontinuity',
    message: "Module uses 'entropy rate' before it is defined.",
    affectedModules: [FAKE_MODULE_ID],
    createdAt: FAKE_ISO,
  };
}

function detour() {
  return {
    id: FAKE_MODULE_ID,
    topicId: FAKE_TOPIC_ID,
    title: 'A quick detour on logarithms',
    ordinal: 99,
    kind: 'detour',
    testOutEligible: false,
    estimatedMinutes: 10,
    state: 'available',
    content: null,
  };
}

function reviewQuestion() {
  return {
    moduleId: FAKE_MODULE_ID,
    topicId: FAKE_TOPIC_ID,
    text: 'Why does a skewed coin carry less than one bit?',
    answered: false,
    correct: null,
  };
}

/**
 * The evaluator's full output shape. A learner answer containing PASS_MARKER passes;
 * anything else fails once and re-asks, which is what the specs drive.
 *
 * WHY the rationale quotes the criterion: C6 refuses a pass whose rationale does not
 * actually reference the module's pass criteria, so a fake that ignored them would make
 * every "pass" in the suite silently become "keep going".
 */
function evaluateOutput(prompt) {
  const criterion = (/^Pass criterion:\s*(.+)$/m.exec(prompt)?.[1] ?? '').trim();
  const passed = prompt.includes('PASS_MARKER');
  if (passed) {
    return {
      reply: 'That is it exactly — you took the expectation over the whole distribution.',
      mode: 'verdict',
      angle: null,
      verdict: {
        outcome: 'pass',
        assistLevel: 0,
        misunderstanding: null,
        nextAngle: null,
        remedialNeeded: false,
        rationale: `The answer met the criterion: ${criterion}`,
      },
    };
  }
  return {
    reply: 'Not quite yet. Try it again from the angle of twenty questions.',
    mode: 'question',
    angle: 'twenty questions',
    verdict: {
      outcome: 'fail',
      assistLevel: 1,
      misunderstanding: 'Treats entropy as a property of one symbol.',
      nextAngle: 'twenty questions',
      remedialNeeded: false,
      rationale: 'The answer never invoked the distribution.',
    },
  };
}

// Two questions, then done: enough for the suite to see a conversation continue and end.
function diagnosticOutput(prompt) {
  const answered = (prompt.match(/Learner answered:/g) ?? []).length;
  if (answered >= 2) return { question: null, priorKnowledge: ['Can multiply matrices'] };
  return {
    question: answered === 0 ? 'What have you already worked with?' : 'Have you inverted a matrix?',
    priorKnowledge: answered === 0 ? [] : ['Can multiply matrices'],
  };
}

function buildOutput(kind, prompt) {
  switch (kind) {
    case 'generate-topic':
      return moduleGraph();
    case 'author-module':
      return moduleContent();
    case 'capstone-spec':
      return capstone();
    case 'discontinuity-review':
      return discontinuityReview();
    case 'extend':
      return extensionGraph();
    case 'detour':
      return detour();
    case 'review-question':
      return reviewQuestion();
    case 'ask':
      return { answer: 'Short answer: it is the same idea, counted in bits.' };
    case 'diagnostic':
      return diagnosticOutput(prompt);
    case 'evaluate':
      return evaluateOutput(prompt);
    default:
      return moduleContent();
  }
}

// WHY no process.exit: on Windows a pipe to a parent is an ASYNCHRONOUS stdout, and
// process.exit() throws away whatever has not drained yet. Under the authoring
// fan-out this fixture handed back JSON cut off mid-write, the app read it as an
// unparseable session, and every lesson failed to be written — a harness race in the
// costume of a product bug. Returning from main() lets the write drain; node exits 0.
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--version')) {
    process.stdout.write('fake-claude 0.0.0-e2e\n');
    return;
  }

  const sent = await readStdin();
  const kind = extractKind(sent);
  // WHY a sentinel in the subject: the suite needs a run that FAILS on purpose, so the
  // subject page can be asked what it shows when the work the learner authorised dies.
  // Nothing else in the fixture can fail on demand, and a spec that waited for a real
  // crash would be waiting on a bug. The word only ever appears in a subject a spec
  // typed, so no other flow can trip it.
  if (sent.includes(FAIL_SENTINEL)) {
    process.stderr.write('fake-claude: failing on request\n');
    process.exitCode = 1;
    return;
  }
  const prompt = recallPrompt(conversationOf(argv), sent);
  if (prompt === null) return;
  if (sent.includes(SLOW_SENTINEL)) {
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
  }
  const output = buildOutput(kind, prompt);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main();
