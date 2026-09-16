// FRACTAL: covers F5, F7 | type unit
import { moduleContentSchema, sessionIdSchema, isoDateStringSchema, type ModuleContent } from '@/shapes';

/**
 * WHY this exists: both perf benchmarks used to seed `content: null`, so no benchmark in the
 * repo had ever paid for a `JSON.parse` of a lesson — which is exactly the cost the shipped
 * read paths carry (`src/store/modules.ts:43`). Real lessons in `data/` average ~28 KB of
 * `content_json`; this synthesises a blob of that size rather than reading one off disk, so
 * the benchmarks still run on a clean clone with no `data/` directory.
 */
const PROSE = [
  'A bound that holds for a *fixed* hypothesis says nothing about the one you trained. The',
  'subscript on $\mathbb{P}$ is doing real work: it names what the randomness is taken over,',
  'and once $\hat{h}$ depends on the sample, the sample is no longer independent of the event.',
  'The union bound is the cheapest repair, and it costs a $\log |\mathcal{H}|$ that you pay',
  'whether or not the extra hypotheses were ever plausible. Everything after this paragraph is',
  'an attempt to pay less: covering numbers, then Rademacher complexity, then the chaining',
  'argument that makes the $\log$ an integral.',
].join(' ');

function prose(i: number) {
  return { kind: 'prose' as const, markdown: `### Step ${i}\n\n${PROSE}\n\n${PROSE}` };
}

/** ~28 KB of JSON, matching the median real lesson. */
export function lessonBlob(seed: number): ModuleContent {
  const blocks: ModuleContent['blocks'] = [];
  for (let i = 0; i < 6; i += 1) {
    blocks.push(prose(seed * 100 + i));
    if (i % 4 === 1) {
      blocks.push({
        kind: 'check',
        question: `How many yes/no questions pin down one of $2^{${i}}$ equally likely outcomes?`,
        options: [`$2^{${i}}$`, `$${i}$`, `$${i + 1}$`],
        answerIndex: 1,
        whyRight: `Each question halves the field, and $\log_2 2^{${i}} = ${i}$. ${PROSE}`,
        whyWrong: `Counting the outcomes rather than the halvings gives $2^{${i}}$. ${PROSE}`,
      });
    }
    if (i % 4 === 2) {
      blocks.push({
        kind: 'table',
        headers: ['Regime', 'Bound', 'Cost', 'When it bites'],
        rows: Array.from({ length: 4 }, (_, r) => [
          `n \gg d$ (row ${r})`,
          `$O(\sqrt{d \log n / n})$`,
          `$\log |\mathcal{H}|$`,
          PROSE.slice(0, 160),
        ]),
        caption: `Comparison table ${i}. ${PROSE.slice(0, 120)}`,
      });
    }
    if (i % 4 === 3) {
      blocks.push({
        kind: 'steps',
        title: `Inverting the bound, ${i}`,
        steps: Array.from({ length: 4 }, (_, s) => ({
          label: `Step ${s + 1}`,
          markdown: `${PROSE}\n\n${PROSE.slice(0, 200)}`,
        })),
      });
    }
  }

  return moduleContentSchema.parse({
    learningGoals: Array.from({ length: 5 }, (_, i) => `${i}. ${PROSE.slice(0, 180)}`),
    warmUp: { prompt: PROSE, expectedStruggle: PROSE.slice(0, 240) },
    explanation: { kind: 'text', markdown: `${PROSE}\n\n${PROSE}` },
    blocks,
    visualization: { kind: 'none' },
    evalScript: {
      objectives: Array.from({ length: 6 }, (_, i) => `Objective ${i}: ${PROSE.slice(0, 200)}`),
      seedQuestions: Array.from({ length: 8 }, (_, i) => `Q${i}: ${PROSE.slice(0, 220)}`),
      angles: Array.from({ length: 6 }, (_, i) => `Angle ${i}: ${PROSE.slice(0, 150)}`),
      misconceptions: Array.from({ length: 5 }, (_, i) => ({
        id: `tb${i}`,
        statement: PROSE.slice(0, 200),
        correction: PROSE.slice(0, 260),
      })),
      passCriteria: Array.from({ length: 5 }, (_, i) => `Pass ${i}: ${PROSE.slice(0, 200)}`),
    },
    authoredAt: isoDateStringSchema.parse('2026-08-22T09:30:00.000Z'),
    authoredBySession: sessionIdSchema.parse('s_perfseed00000000'),
  });
}
