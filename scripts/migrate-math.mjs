#!/usr/bin/env node
// FRACTAL: implements F3 | component C4
//
// One-time backfill. Curricula authored before the LaTeX convention wrote their maths as
// Unicode and backtick spans (`wᵀAw = Σᵢ Σⱼ Aᵢⱼ wᵢ wⱼ`), which the viewer now shows as
// literal source instead of typesetting. This rewrites stored module content into the LaTeX
// that the renderer (C10) and the authoring prompt (MATH_CONVENTION) both expect.
//
// Scope is deliberately narrow: it converts only maths the ORIGINAL author already
// delimited — a backtick span, or a bold run alone on its line — because the delimiter
// itself fixes where the formula begins and ends. See NOT-DONE below for why loose prose
// maths is left alone. A span that looks like code (a quoted string, an einsum call, a
// Python shape tuple) stays code.
//
// Usage:
//   node scripts/migrate-math.mjs            # dry run: print every conversion, change nothing
//   node scripts/migrate-math.mjs --apply    # back up, then rewrite the DB rows and content files

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------ symbols */

const SUBSCRIPTS = {
  '\u1d62': 'i', '\u2c7c': 'j', '\u2096': 'k', '\u2099': 'n', '\u2098': 'm',
  '\u2080': '0', '\u2081': '1', '\u2082': '2', '\u2083': '3',
};

const SUPERSCRIPTS = {
  '\u1d40': '\\top', '\u2071': 'n', '\u00b2': '2', '\u00b3': '3',
  '\u00b9': '1', '\u207a': '+', '\u207b': '-',
};

/** Single codepoints that mean the same thing wherever they appear in maths. */
const SYMBOLS = new Map(Object.entries({
  '\u2207': cmd('nabla'), '\u221e': cmd('infty'), '\u2208': cmd('in'), '\u221d': cmd('propto'),
  '\u2265': cmd('ge'), '\u2264': cmd('le'), '\u2248': cmd('approx'), '\u2260': cmd('ne'),
  '\u226a': cmd('ll'), '\u2192': cmd('to'), '\u2194': cmd('leftrightarrow'),
  '\u00b7': cmd('cdot'), '\u00d7': cmd('times'), '\u2026': cmd('dots'),
  '\u2212': '-', '\u2013': '-',
  '\u27e8': cmd('langle'), '\u27e9': cmd('rangle'),
  '\u03bb': cmd('lambda'), '\u03c3': cmd('sigma'), '\u03b8': cmd('theta'), '\u03bc': cmd('mu'),
  '\u03b5': cmd('epsilon'), '\u03b7': cmd('eta'), '\u03ba': cmd('kappa'),
  '\u039b': cmd('Lambda'), '\u0394': cmd('Delta'),
  '\u211d': '\\mathbb{R}', '\u0177': '\\hat{y}', '\u0176': '\\hat{Y}', '\u2016': '\\|',
}));

/** Any of these means "this text is maths", not prose and not code. */
const MATH_CHARS =
  /[\u1d40\u2071\u1d62\u2c7c\u2096\u2099\u2098\u2080-\u2083\u00b2\u00b3\u00b9\u207b\u207a\u2207\u221e\u2208\u221d\u2265\u2264\u2248\u2260\u226a\u2192\u2194\u00b7\u00d7\u2212\u2016\u27e8\u27e9\u03bb\u03c3\u03b8\u03bc\u03b5\u03b7\u03ba\u039b\u0394\u211d\u0177\u0176\u03a3\u221a]/;

/**
 * Runs of Unicode sub/superscripts must collapse into ONE braced group. Mapping them one at
 * a time produces `M_i_i` for Mᵢᵢ — a LaTeX double-subscript error — and `A_i_j` for Aᵢⱼ,
 * which is not what the author wrote either.
 */
function collapseScripts(input) {
  const sub = Object.keys(SUBSCRIPTS).join('');
  const sup = Object.keys(SUPERSCRIPTS).join('');
  let out = input.replace(new RegExp('[' + sub + ']+', 'gu'), (run) => {
    const body = [...run].map((c) => SUBSCRIPTS[c]).join('');
    return body.length === 1 ? '_' + body : '_{' + body + '}';
  });
  out = out.replace(new RegExp('[' + sup + ']+', 'gu'), (run) => {
    const body = [...run].map((c) => SUPERSCRIPTS[c]).join('');
    if (body === '\\top') return '^' + cmd('top');
    return body.length === 1 ? '^' + body : '^{' + body + '}';
  });
  return out;
}

/**
 * Σ is two different things in this corpus and getting it backwards silently changes what a
 * lesson teaches. It is the summation operator when indexed by i or j (`Σᵢ Σⱼ Aᵢⱼ`), and the
 * singular-value matrix of an SVD otherwise — bare, or indexed by the truncation rank k
 * (`M = UΣVᵀ`, `M_k = U_k Σ_k V_kᵀ`). Every one of the nine occurrences in this corpus is
 * classified correctly by that rule; it runs after collapseScripts, so the index is already
 * an ASCII `_i`.
 */
function replaceSigma(input) {
  return input.replace(/\u03a3(_\{?([ij]+)\}?)?/gu, (whole, index, letters) => {
    if (index !== undefined && letters !== undefined) return cmd('sum') + index;
    return cmd('Sigma') + (index ?? '');
  });
}

/** `√50`, `√d`, `√d_k`, `sqrt(9+16)` all become \sqrt{...}. */
function replaceRoots(input) {
  let out = input.replace(/sqrt\(([^()]*)\)/g, (_m, body) => '\\sqrt{' + body + '}');
  out = out.replace(/\u221a([A-Za-z0-9]+(?:_\{[^}]+\}|_[A-Za-z0-9])?)/g, (_m, body) => '\\sqrt{' + body + '}');
  return out;
}

/** Multi-character subscripts must be braced: `W_ij` is W_{ij}, not W_i j. */
function braceSubscripts(input) {
  return input.replace(/_([A-Za-z0-9]{2,})\b/g, (_m, body) => '_{' + body + '}');
}

/**
 * A LaTeX command that runs straight into a letter becomes a DIFFERENT, undefined command:
 * `U\Sigma V^\top` must not collapse to `U\SigmaV^\top`, where `\SigmaV` does not exist.
 *
 * Repairing that afterwards with /(\\[a-zA-Z]+)(?=[A-Za-z])/ does NOT work: a command name
 * is itself letters, so the greedy group backtracks into the middle of one and
 * `\operatorname` comes out as `\operatornam e`. Instead every command is emitted with a
 * trailing space, which LaTeX ignores, and runs of spaces are collapsed at the end.
 */
function cmd(name) {
  return '\\' + name + ' ';
}

/**
 * Turn one already-identified run of maths into LaTeX. Order matters: script runs collapse
 * before anything reads a subscript, roots consume the radical before the symbol table would
 * strip it, and commands are spaced last, once every command exists.
 */
export function toLatex(raw) {
  let s = raw;
  s = s.replace(/\*\*([A-Za-z\u0370-\u03ff]+)\*\*/g, (_m, v) => '\\mathbf{' + v + '}');
  s = collapseScripts(s);
  s = replaceRoots(s);
  s = replaceSigma(s);
  s = s.replace(/\|\|/g, '\\|');
  s = s.replace(/\.\.\./g, cmd('dots'));
  s = s.replace(/->/g, cmd('to'));
  s = s.replace(/\^T\b/g, '^' + cmd('top'));
  // The negative lookbehinds stop these from re-matching what an earlier pass emitted:
  // without them replaceSigma's `\sum_i` is seen again and becomes `\\sum_i`.
  s = s.replace(/(?<!\\)\bsum_/g, cmd('sum') + '_');
  s = s.replace(/(?<!\\)\blambda\b/g, cmd('lambda'));
  for (const [from, to] of SYMBOLS) s = s.split(from).join(to);
  s = braceSubscripts(s);
  // `R^(n x n)` superscripts only the opening paren in LaTeX; the author meant the group.
  s = s.replace(/\^\(([^()]+)\)/g, (_m, body) => '^{' + body + '}');
  // `(d x n)(n x 1)` uses a bare x for multiplication. Only inside a dimension group, where
  // x cannot be the variable x, is it safe to read it as \times.
  s = s.replace(/\((\s*[A-Za-z0-9_{}\\^]+(?:\s+x\s+[A-Za-z0-9_{}\\^]+)+\s*)\)/g,
    (_m, body) => '(' + body.replace(/\s+x\s+/g, ' \\times ') + ')');
  // Function names are upright operators, not a product of italic letters: bare `softmax`
  // typesets as s·o·f·t·m·a·x. The word boundaries matter — without them `tr` hits "matrix".
  s = s.replace(/\b(softmax|argmin|argmax|diag|rank|trace|tr|det|exp|log|min|max)\b/g,
    (_m, fn) => '\\operatorname{' + fn + '}');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

/* --------------------------------------------------------------- classifier */

/** Signals the span is code and must stay in a code font. */
const CODE_RE = /['"]|einsum|import |def |np\.|torch\.|\.shape|=>|\bbatch\b/;

/** A lone `(d_in,)` or `(d_out, d_in)` is a Python shape tuple, not a formula. */
const TUPLE_RE = /^\([A-Za-z_][A-Za-z0-9_]*(,\s*[A-Za-z_][A-Za-z0-9_]*)*,?\)$/;

export function classifySpan(body) {
  if (CODE_RE.test(body)) return 'code';
  if (TUPLE_RE.test(body)) return 'code';
  if (MATH_CHARS.test(body)) return 'math';
  if (/[\^_=]|\\/.test(body)) return 'math';
  if (/^[A-Za-z](\([^)]*\))?$/.test(body)) return 'math';          // a lone symbol: A, b, f(x)
  if (/^[A-Za-z]{1,3}$/.test(body)) return 'math';                 // AB, XW
  if (/\b(sqrt|sum|softmax|tr|det)\b/.test(body)) return 'math';
  if (/^\(?\s*[A-Za-z0-9]+(\s+x\s+[A-Za-z0-9]+)+\s*\)?$/.test(body)) return 'math'; // (m x k)
  return 'code';
}

/* ---------------------------------------------------------------- rewriting */

const record = [];
function note(kind, before, after) {
  if (before !== after) record.push({ kind, before, after });
}

function convertSpans(text) {
  return text.replace(/`([^`\n]+)`/g, (whole, body) => {
    if (classifySpan(body) === 'code') return whole;
    const tex = toLatex(body);
    note('inline', whole, '$' + tex + '$');
    return '$' + tex + '$';
  });
}

/** Markdown: backtick spans and standalone bold formula lines. Fenced code is untouched. */
export function convertMarkdown(md) {
  return md
    .split(/(```[\s\S]*?```)/g)
    .map((part) => {
      if (part.startsWith('```')) return part;
      let out = convertSpans(part);
      // A bold run alone on its line is how this corpus writes display maths.
      out = out.replace(/^\*\*(.+?)\*\*$/gm, (whole, body) => {
        if (!MATH_CHARS.test(body) && !/[\^_]/.test(body)) return whole;
        if (!body.includes('=')) return whole;
        const tex = toLatex(body);
        note('display', whole, '$$' + tex + '$$');
        return '$$' + tex + '$$';
      });
      return out;
    })
    .join('');
}

/**
 * NOT DONE, DELIBERATELY: wrapping bare maths loose in prose, e.g. a learning goal reading
 * "the gradient of x^T A x". Two token-run walkers were written and discarded; both produced
 * unbalanced fragments — "(3+4+0+0+12=19). They", "(v₁", "1000 ×" — and one swallowed a whole
 * sentence into a formula. Deciding where a formula ends inside an English sentence is a
 * semantic judgement, not a lexical one, and a wrong cut silently changes what a lesson
 * teaches. Loose prose maths is therefore left exactly as it renders today (no regression);
 * re-authoring a module is the way to upgrade it, now that the prompt carries MATH_CONVENTION.
 */
function convertPlain(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  return convertSpans(text);
}

/** Walk every learner-facing string in a ModuleContent. */
export function convertContent(content) {
  const c = structuredClone(content);
  c.learningGoals = (c.learningGoals ?? []).map(convertPlain);
  if (c.warmUp) {
    c.warmUp.prompt = convertPlain(c.warmUp.prompt);
    c.warmUp.expectedStruggle = convertPlain(c.warmUp.expectedStruggle);
  }
  if (c.explanation?.kind === 'text') c.explanation.markdown = convertMarkdown(c.explanation.markdown);
  if (c.explanation?.kind === 'video') c.explanation.why = convertPlain(c.explanation.why);
  if (c.visualization?.kind === 'table') {
    c.visualization.headers = c.visualization.headers.map(convertPlain);
    c.visualization.rows = c.visualization.rows.map((r) => r.map(convertPlain));
    c.visualization.caption = convertPlain(c.visualization.caption);
  }
  if (c.visualization?.kind === 'svg') c.visualization.caption = convertPlain(c.visualization.caption);
  if (c.evalScript) {
    const e = c.evalScript;
    e.objectives = (e.objectives ?? []).map(convertPlain);
    e.seedQuestions = (e.seedQuestions ?? []).map(convertPlain);
    e.passCriteria = (e.passCriteria ?? []).map(convertPlain);
    e.misconceptions = (e.misconceptions ?? []).map((m) => ({
      ...m,
      statement: convertPlain(m.statement),
      correction: convertPlain(m.correction),
    }));
  }
  return c;
}

/**
 * Every formula this migration produces is handed to the real typesetter with errors made
 * fatal. A conversion that cannot be parsed would reach the learner as red error text, so it
 * is caught here instead of on the page.
 */
export async function validateMath(content) {
  const { default: katex } = await import('katex');
  const failures = [];

  // Walk the real strings, not the JSON encoding of them: scanning JSON text would see every
  // `\top` as `\\top` and would have to guess its way back out again.
  const strings = [];
  const walk = (v) => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(content);

  for (const s of strings) {
    const re = /\$\$([^$]+)\$\$|\$([^$\n]+)\$/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      const tex = m[1] ?? m[2];
      try {
        katex.renderToString(tex, { throwOnError: true, strict: false, trust: false });
      } catch (e) {
        failures.push({ tex, reason: String(e.message ?? e).slice(0, 140) });
      }
    }
  }
  return failures;
}

/** Must match contentDigest() in src/orchestrator/reconcile.ts, or the file reads as tampered. */
export function digestOf(content) {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

export function takeRecord() {
  const out = record.slice();
  record.length = 0;
  return out;
}

/* -------------------------------------------------------------------- driver */

async function main() {
  const apply = process.argv.includes('--apply');
  const dataRoot = 'data';
  const dbPath = path.join(dataRoot, 'learn.db');

  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath);
  const rows = db
    .prepare('select id, topic_id, content_json from module_nodes where content_json is not null')
    .all();

  if (apply) {
    // Checkpoint first: this database runs in WAL mode, so committed rows can still be
    // sitting in learn.db-wal. Copying the main file alone would back up a stale database
    // and quietly make the rollback path useless.
    db.pragma('wal_checkpoint(TRUNCATE)');
    copyFileSync(dbPath, dbPath + '.pre-math');
    console.log('backed up ' + dbPath + ' -> ' + dbPath + '.pre-math');
  }

  let changedModules = 0;
  const badMath = [];
  const allChanges = [];
  const update = db.prepare('update module_nodes set content_json = ? where id = ?');

  for (const row of rows) {
    const before = JSON.parse(row.content_json);
    takeRecord();
    const after = convertContent(before);
    const changes = takeRecord();

    const bad = await validateMath(after);
    if (bad.length > 0) {
      badMath.push({ id: row.id, bad });
      // A module whose formulas do not parse is left exactly as it was. Partial application
      // is worse than none: the learner would get a lesson half in red error text.
      if (apply) {
        console.error('REFUSED ' + row.id + ': ' + bad.length + ' formulas do not parse');
        continue;
      }
    }
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    changedModules += 1;
    allChanges.push({ id: row.id, changes });

    if (!apply) continue;

    update.run(JSON.stringify(after), row.id);

    // The content file is digest-verified on load, so the digest must be recomputed here or
    // the app will treat the lesson as tampered with and refuse it.
    const file = path.join(dataRoot, 'topics', row.topic_id, 'modules', row.id, 'content.json');
    if (existsSync(file)) {
      const envelope = JSON.parse(readFileSync(file, 'utf8'));
      const next = { contentVersion: envelope.contentVersion, digest: digestOf(after), content: after };
      const tmp = file + '.tmp';
      const prev = file + '.prev';
      writeFileSync(tmp, JSON.stringify(next), 'utf8');
      if (existsSync(prev)) unlinkSync(prev);
      renameSync(file, prev);
      renameSync(tmp, file);
    }
  }

  for (const mod of allChanges) {
    console.log('\n=== ' + mod.id + ' (' + mod.changes.length + ') ===');
    for (const c of mod.changes) console.log('  [' + c.kind + '] ' + c.before + '\n        -> ' + c.after);
  }
  for (const m of badMath) {
    console.log('\nUNPARSEABLE in ' + m.id + ':');
    for (const b of m.bad) console.log('   ' + b.tex + '  --  ' + b.reason);
  }

  const total = allChanges.reduce((n, m) => n + m.changes.length, 0);
  console.log(
    '\n' + (apply ? 'APPLIED' : 'DRY RUN') + ': ' + total + ' conversions across ' +
    changedModules + '/' + rows.length + ' modules; ' + badMath.length + ' modules with unparseable maths',
  );
  db.close();
}

// pathToFileURL, not string surgery: a Windows argv[1] is `C:\...`, whose file URL carries
// three slashes, so a hand-built `file://` prefix never matches and main() silently no-ops.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
