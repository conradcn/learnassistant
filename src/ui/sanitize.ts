// FRACTAL: implements F3 | component C10
import { renderMath, splitMath } from '@/ui/math';

const MEMO_LIMIT = 64;

/**
 * WHY (defence in depth): C4 host-allowlists a video link at ingest. This is the second,
 * independent check at render time, so a row that reached the database another way still
 * cannot become a clickable link.
 */
export const VIDEO_HOST_ALLOWLIST: readonly string[] = ['youtube.com', 'youtu.be', 'vimeo.com'];

const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i;

export function isSafeVideoUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username.length > 0 || parsed.password.length > 0) return false;
  if (PRIVATE_HOST_RE.test(parsed.hostname)) return false;
  const host = parsed.hostname.toLowerCase();
  return VIDEO_HOST_ALLOWLIST.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export function isSafeLinkUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && parsed.username.length === 0 && parsed.password.length === 0;
}

/** A cheap content digest — the memo key only has to be stable, not unforgeable. */
export function contentDigest(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}${value.length.toString(16)}`;
}

function memoize(cache: Map<string, string>, key: string, produce: () => string): string {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = produce();
  cache.set(key, value);
  if (cache.size > MEMO_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  }
  return value;
}

/**
 * WHY: models routinely emit HTML entities in prose and in diagram/table labels
 * (`&#8212;`, `&amp;`, `&rarr;`), because their training data is HTML. Everything here is
 * escaped before rendering, so an undecoded entity reaches the learner as the literal
 * text `&#8212;` instead of an em dash. Decoding first, then escaping, keeps that safe:
 * `&lt;script&gt;` decodes to `<script>` and is escaped straight back again.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  times: '×',
  divide: '÷',
  minus: '−',
  plusmn: '±',
  deg: '°',
  micro: 'µ',
  frac12: '½',
  ne: '≠',
  le: '≤',
  ge: '≥',
  approx: '≈',
  infin: '∞',
  sum: '∑',
  prod: '∏',
  radic: '√',
  int: '∫',
  part: '∂',
  larr: '←',
  uarr: '↑',
  rarr: '→',
  darr: '↓',
  harr: '↔',
  rArr: '⇒',
  hArr: '⇔',
  bull: '•',
  middot: '·',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  theta: 'θ',
  lambda: 'λ',
  mu: 'μ',
  pi: 'π',
  sigma: 'σ',
  phi: 'φ',
  omega: 'ω',
  Delta: 'Δ',
  Sigma: 'Σ',
  Omega: 'Ω',
};

const ENTITY_RE = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

function codePoint(digits: string, radix: number): string | null {
  const value = Number.parseInt(digits, radix);
  // Surrogate halves and out-of-range values would throw or produce lone surrogates.
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) return null;
  if (value >= 0xd800 && value <= 0xdfff) return null;
  return String.fromCodePoint(value);
}

/** Decode the HTML entities a model writes into otherwise-plain text. */
export function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(ENTITY_RE, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return codePoint(body.slice(2), 16) ?? whole;
    if (body.startsWith('#')) return codePoint(body.slice(1), 10) ?? whole;
    return NAMED_ENTITIES[body] ?? whole;
  });
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(escaped: string): string {
  let out = escaped.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_whole, label: string, href: string) => {
    const url = href.replace(/&amp;/g, '&');
    if (!isSafeLinkUrl(url)) return label;
    return `<a href="${escapeHtml(url)}" rel="noopener noreferrer" target="_blank">${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, bold: string) => `<strong>${bold}</strong>`);
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, (_m, lead: string, italic: string) => `${lead}<em>${italic}</em>`);
  return out;
}

/**
 * One line of model prose: LaTeX runs are typeset, everything else is escaped before any
 * markup is generated. Math is split out FIRST, because a formula's own backslashes and
 * braces would otherwise be mangled by the markdown pass — `$a_*b*_c$` is a subscript, not
 * an emphasis. The trade is that markdown spanning a formula (`**bold $x$ bold**`) is
 * emphasised on each side of the math rather than across it, which is invisible in output.
 */
function prose(raw: string): string {
  return splitMath(decodeEntities(raw))
    .map((segment) =>
      segment.kind === 'math'
        ? renderMath(segment.tex, segment.display)
        : inline(escapeHtml(segment.value)),
    )
    .join('');
}

const mathTextCache = new Map<string, string>();

/**
 * The same treatment for the many fields that are a plain string rather than markdown —
 * learning goals, warm-up prompts, question stems, table cells. A learner meets just as
 * much math in a question as in the explanation.
 */
export function renderTextWithMath(raw: string): string {
  return memoize(mathTextCache, `tx:${contentDigest(raw)}`, () => prose(raw));
}

type Block = { kind: 'p' | 'ul' | 'ol' | 'quote' | 'code'; lines: string[]; level?: number };

function blocksOf(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let fence: Block | null = null;
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (fence === null) {
        fence = { kind: 'code', lines: [] };
      } else {
        blocks.push(fence);
        fence = null;
      }
      continue;
    }
    if (fence !== null) {
      fence.lines.push(line);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading !== null) {
      blocks.push({ kind: 'p', lines: [heading[2]], level: heading[1].length });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      const last = blocks[blocks.length - 1];
      if (last !== undefined && last.kind === 'ul') last.lines.push(bullet[1]);
      else blocks.push({ kind: 'ul', lines: [bullet[1]] });
      continue;
    }
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (numbered !== null) {
      const last = blocks[blocks.length - 1];
      if (last !== undefined && last.kind === 'ol') last.lines.push(numbered[1]);
      else blocks.push({ kind: 'ol', lines: [numbered[1]] });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote !== null) {
      const last = blocks[blocks.length - 1];
      if (last !== undefined && last.kind === 'quote') last.lines.push(quote[1]);
      else blocks.push({ kind: 'quote', lines: [quote[1]] });
      continue;
    }
    if (line.trim().length === 0) {
      blocks.push({ kind: 'p', lines: [] });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last !== undefined && last.kind === 'p' && last.level === undefined && last.lines.length > 0) {
      last.lines.push(line);
    } else {
      blocks.push({ kind: 'p', lines: [line] });
    }
  }
  if (fence !== null) blocks.push(fence);
  return blocks;
}

function renderBlock(block: Block): string {
  if (block.kind === 'code') {
    return `<pre><code>${escapeHtml(block.lines.join('\n'))}</code></pre>`;
  }
  if (block.kind === 'ul' || block.kind === 'ol') {
    const items = block.lines.map((l) => `<li>${prose(l)}</li>`).join('');
    return block.kind === 'ul' ? `<ul>${items}</ul>` : `<ol>${items}</ol>`;
  }
  if (block.kind === 'quote') {
    return `<blockquote>${prose(block.lines.join(' '))}</blockquote>`;
  }
  if (block.lines.length === 0) return '';
  const body = prose(block.lines.join(' '));
  if (block.level !== undefined) return `<h${block.level}>${body}</h${block.level}>`;
  return `<p>${body}</p>`;
}

const markdownCache = new Map<string, string>();

/**
 * Markdown with raw HTML disabled: every character of the model's output is escaped
 * before any markup is generated, so the only tags in the result are the ones this
 * function emits.
 */
export function renderMarkdown(markdown: string): string {
  return memoize(markdownCache, `md:${contentDigest(markdown)}`, () =>
    blocksOf(markdown).map(renderBlock).join(''),
  );
}

/** Exported so tests can pin the allowlist itself: widening it must fail a test, not pass silently. */
export const SVG_ELEMENTS: ReadonlySet<string> = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'defs', 'marker', 'title', 'desc', 'linearGradient', 'radialGradient', 'stop',
]);

/** Exported for the same reason as SVG_ELEMENTS. */
export const SVG_ATTRS: ReadonlySet<string> = new Set([
  'viewbox', 'width', 'height', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'points', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
  'opacity', 'fill-opacity', 'stroke-opacity', 'transform', 'text-anchor', 'dominant-baseline',
  'font-size', 'font-family', 'font-weight', 'dx', 'dy', 'offset', 'stop-color', 'stop-opacity',
  'gradientunits', 'marker-end', 'marker-start', 'preserveaspectratio',
]);

const ATTR_CANONICAL: ReadonlyMap<string, string> = new Map([
  ['viewbox', 'viewBox'],
  ['gradientunits', 'gradientUnits'],
  ['preserveaspectratio', 'preserveAspectRatio'],
]);

const ELEMENT_CANONICAL: ReadonlyMap<string, string> = new Map([
  ['lineargradient', 'linearGradient'],
  ['radialgradient', 'radialGradient'],
]);

function attrValueAllowed(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower.includes('url(') || lower.includes('javascript:') || lower.includes('data:')) return false;
  if (lower.includes('http://') || lower.includes('https://') || lower.includes('//')) return false;
  if (lower.includes('<') || lower.includes('&#')) return false;
  return value.length <= 4096;
}

function sanitizeAttributes(raw: string): string {
  const out: string[] = [];
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match = attrRe.exec(raw);
  while (match !== null) {
    const name = match[1].toLowerCase();
    // Decode BEFORE the checks, never after: `&#106;avascript:` has to be read as the
    // scheme it becomes, not as the harmless-looking text it is written as.
    const value = decodeEntities(match[3] ?? match[4] ?? '');
    if (!name.startsWith('on') && SVG_ATTRS.has(name) && attrValueAllowed(value)) {
      out.push(`${ATTR_CANONICAL.get(name) ?? name}="${escapeHtml(value)}"`);
    }
    match = attrRe.exec(raw);
  }
  return out.length === 0 ? '' : ` ${out.join(' ')}`;
}

/**
 * An allowlist SVG sanitizer over UNTRUSTED model output: unknown elements are dropped
 * together with everything they contain, every attribute must be on the allowlist, and no
 * attribute may reference anything outside the document.
 */
export function sanitizeSvg(svg: string): string {
  return memoize(svgCache, `svg:${contentDigest(svg)}`, () => sanitizeSvgUncached(svg));
}

const svgCache = new Map<string, string>();

function sanitizeSvgUncached(svg: string): string {
  const source = svg.replace(/<!--[\s\S]*?-->/g, '');
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  const out: string[] = [];
  const open: string[] = [];
  let skipDepth = 0;
  let skipTag = '';
  let cursor = 0;
  let match = tagRe.exec(source);
  while (match !== null) {
    const text = source.slice(cursor, match.index);
    // Decode then escape, as prose does: a label written `A &rarr; B` must reach the
    // learner as an arrow, not as the literal characters `&rarr;`. Escaping straight
    // away would freeze the artifact into the drawing.
    if (skipDepth === 0 && text.length > 0) out.push(escapeHtml(decodeEntities(text)));
    cursor = match.index + match[0].length;

    const rawName = match[1].toLowerCase();
    const name = ELEMENT_CANONICAL.get(rawName) ?? rawName;
    const closing = match[0].startsWith('</');
    const selfClosing = match[0].endsWith('/>');

    if (skipDepth > 0) {
      if (rawName === skipTag) skipDepth += closing ? -1 : selfClosing ? 0 : 1;
      match = tagRe.exec(source);
      continue;
    }

    if (!SVG_ELEMENTS.has(name)) {
      if (!closing && !selfClosing) {
        skipDepth = 1;
        skipTag = rawName;
      }
      match = tagRe.exec(source);
      continue;
    }

    if (closing) {
      const expected = open.pop();
      if (expected !== undefined) out.push(`</${expected}>`);
    } else if (selfClosing) {
      out.push(`<${name}${sanitizeAttributes(match[2])} />`);
    } else {
      open.push(name);
      out.push(`<${name}${sanitizeAttributes(match[2])}>`);
    }
    match = tagRe.exec(source);
  }
  if (skipDepth === 0) {
    const tail = source.slice(cursor);
    if (tail.length > 0) out.push(escapeHtml(decodeEntities(tail)));
  }
  while (open.length > 0) out.push(`</${open.pop() ?? 'g'}>`);
  return out.join('');
}

export function resetSanitizeMemo(): void {
  markdownCache.clear();
  mathTextCache.clear();
  svgCache.clear();
}
