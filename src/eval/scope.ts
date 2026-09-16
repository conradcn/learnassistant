// FRACTAL: implements F4 | component C6
import type { ModuleContent, ModuleNode } from '@/shapes';

/**
 * WHY this file exists: the evaluate prompt opens with "the learner has just studied the
 * lesson below" and then never included the lesson. The evaluator only ever saw the
 * objectives and the pass criteria, so it filled the gap from its own knowledge of the
 * subject and gated the module on material the learner was never taught — the ordinary
 * failure being a term, a formula or a follow-on result that lives in a later module.
 *
 * What is sent is the lesson as TAUGHT — every line of the body the learner read, in
 * reading order — so "was this covered?" is a lookup for the evaluator rather than a guess.
 */

/** Bounds the scope block so a long lesson cannot crowd out the transcript. */
export const MAX_SCOPE_ITEMS = 60;
export const MAX_SCOPE_CHARS = 600;

function clamp(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_SCOPE_CHARS ? flat : `${flat.slice(0, MAX_SCOPE_CHARS)}…`;
}

// WHY every block kind contributes: a figure's caption, a check's question and a steps
// block's labels are all things the learner was shown, and each is a fair thing to ask
// about. Only the raw SVG is dropped — it is markup, not teaching.
function blockLines(content: ModuleContent): string[] {
  const out: string[] = [];
  for (const block of content.blocks ?? []) {
    if (block.kind === 'prose') out.push(block.markdown);
    else if (block.kind === 'figure') out.push(`Figure: ${block.caption}`);
    else if (block.kind === 'table') {
      out.push(`Table: ${block.caption} — columns: ${block.headers.join(', ')}`);
      for (const row of block.rows) out.push(`Table row: ${row.join(' | ')}`);
    } else if (block.kind === 'check') {
      out.push(`Check: ${block.question} — answer: ${block.options[block.answerIndex] ?? ''}. ${block.whyRight}`);
    } else if (block.kind === 'reveal') out.push(`Worked: ${block.prompt} — ${block.answer}`);
    else {
      out.push(`Steps — ${block.title}`);
      for (const step of block.steps) out.push(`Step ${step.label}: ${step.markdown}`);
    }
  }
  return out;
}

/**
 * The material the learner was actually taught, in reading order. Empty when the module
 * has no authored content — an ephemeral or not-yet-authored one — and the caller then
 * says so rather than pretending the scope is empty.
 */
export function taughtScope(node: ModuleNode | null): string[] {
  const content = node?.content ?? null;
  if (content === null) return [];
  const lines: string[] = [
    ...content.learningGoals.map((g) => `Learning goal: ${g}`),
    content.explanation.kind === 'text'
      ? `Opening: ${content.explanation.markdown}`
      : `Opening: a video, "${content.explanation.title}" (${content.explanation.channel}) — ${content.explanation.why}`,
    `Warm-up asked before the lesson: ${content.warmUp.prompt}`,
    ...blockLines(content),
  ];
  return lines.map(clamp).filter((l) => l.length > 0).slice(0, MAX_SCOPE_ITEMS);
}

/**
 * The instruction half. WHY it is stated three ways: "stay in scope" alone reads as a
 * soft preference and the model still reached for the next idea along when the learner
 * answered well. Naming what to do INSTEAD — go deeper on the same material — is what
 * stops the drift, and the last line keeps an out-of-scope answer from being punished.
 */
export function scopeInstructions(scope: string[]): string[] {
  if (scope.length === 0) {
    return [
      'This module has no written lesson. Test only what the objectives above name, and nothing that depends on material beyond them.',
    ];
  }
  return [
    'SCOPE: the lesson content below is everything the learner has been taught here.',
    'Ask only about ideas, terms, notation and results that appear in it. If something is',
    'not in it, it is not on the test — including anything you know about this subject',
    'from elsewhere, and anything a later module would cover.',
    'To make a question harder, go deeper on this material — a new case, a failure mode, a',
    'transfer to their own situation — rather than reaching for material it does not cover.',
    'If the learner brings in something outside the scope, engage with it, but never make',
    'passing depend on it, and never fail them for not knowing it.',
  ];
}
