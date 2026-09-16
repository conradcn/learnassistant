// FRACTAL: implements F3 | component C10
import katex from 'katex';

/**
 * WHY: this is educational software for subjects that are frequently mathematical, and a
 * lesson that shows a learner `\frac{-b \pm \sqrt{b^2-4ac}}{2a}` as literal backslashes has
 * failed at the only job it has. Math is written as LaTeX by the authoring session and
 * typeset here.
 */
export type MathSegment =
  | { kind: 'text'; value: string }
  | { kind: 'math'; tex: string; display: boolean };

/**
 * WHY (untrusted input): every character of `tex` came from a model. KaTeX is a pure
 * typesetter — it never evaluates and never emits script — but two of its knobs still
 * matter here. `trust: false` (the default, stated for the reader) keeps `\href` and
 * `\includegraphics` from turning a lesson into a link farm, and the expansion/size caps
 * bound what a pathological macro can cost the browser.
 */
const KATEX_OPTIONS = {
  throwOnError: false,
  // The error colour is the raw source of a formula KaTeX could not parse -- the whole
  // content of that formula, for the learner. It must clear SC 1.4.3's 4.5:1 on every
  // surface math is rendered on: 6.28:1 on --panel, 6.97:1 on --bg. Same hue as --danger.
  errorColor: '#fb7185',
  strict: false as const,
  trust: false,
  maxSize: 64,
  maxExpand: 256,
  output: 'htmlAndMathml' as const,
};

/**
 * A display equation wider than the content column scrolls inside its own box (see
 * `.katex-display` in globals.css) rather than widening the document. A box that only a
 * mouse can scroll is a box a keyboard-only learner cannot read, so the scroller is made
 * focusable and labelled here, where the element is emitted.
 */
function makeDisplayScrollable(html: string): string {
  return html.replace(
    '<span class="katex-display">',
    '<span class="katex-display" tabindex="0" role="group" aria-label="Display equation">',
  );
}

/**
 * Typeset one LaTeX fragment. Invalid LaTeX is never fatal: KaTeX renders the offending
 * source in the error colour, so a lesson with one bad formula still teaches the rest of
 * itself rather than blanking the page.
 */
export function renderMath(tex: string, display: boolean): string {
  try {
    const html = katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: display });
    return display ? makeDisplayScrollable(html) : html;
  } catch {
    // Reached only if KaTeX throws despite throwOnError:false (e.g. maxSize exceeded).
    return `<code class="la-math-error">${tex.replace(/[&<>"']/g, (c) =>
      c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
    )}</code>`;
  }
}

const DELIMITERS: readonly { open: string; close: string; display: boolean }[] = [
  { open: '$$', close: '$$', display: true },
  { open: '\\[', close: '\\]', display: true },
  { open: '\\(', close: '\\)', display: false },
  { open: '$', close: '$', display: false },
];

function pushText(out: MathSegment[], value: string): void {
  if (value.length === 0) return;
  const last = out[out.length - 1];
  if (last !== undefined && last.kind === 'text') last.value += value;
  else out.push({ kind: 'text', value });
}

/**
 * Split raw (unescaped) source into prose and LaTeX runs.
 *
 * Three things are deliberately left alone. A backtick code span is copied out verbatim,
 * so `$5 and $6` in code is money and not a broken formula. `\$` is an escape hatch for a
 * literal dollar in prose. And an unpaired delimiter stays text rather than swallowing the
 * rest of the paragraph — a lone "$100" reads as a price, which is what the learner meant.
 */
export function splitMath(raw: string): MathSegment[] {
  const out: MathSegment[] = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];

    if (ch === '\\' && raw[i + 1] === '$') {
      pushText(out, '$');
      i += 2;
      continue;
    }

    if (ch === '`') {
      const end = raw.indexOf('`', i + 1);
      if (end === -1) {
        pushText(out, raw.slice(i));
        break;
      }
      pushText(out, raw.slice(i, end + 1));
      i = end + 1;
      continue;
    }

    const delim = DELIMITERS.find((d) => raw.startsWith(d.open, i));
    if (delim !== undefined) {
      const from = i + delim.open.length;
      const end = raw.indexOf(delim.close, from);
      const tex = end === -1 ? '' : raw.slice(from, end).trim();
      if (end !== -1 && tex.length > 0) {
        out.push({ kind: 'math', tex, display: delim.display });
        i = end + delim.close.length;
        continue;
      }
    }

    pushText(out, ch);
    i += 1;
  }
  return out;
}

/** True when the source contains anything this module would typeset. */
export function hasMath(raw: string): boolean {
  return splitMath(raw).some((segment) => segment.kind === 'math');
}
