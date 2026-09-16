// FRACTAL: implements F1 | component C11
import { MAX_SOURCE_CHARS, type SourceKind } from '@/shapes';

/** The page separator extraction emits and every later stage understands. */
export const PAGE_BREAK = '\f';

const EXTENSION_KINDS: Record<string, SourceKind> = {
  pdf: 'pdf',
  docx: 'docx',
  md: 'markdown',
  markdown: 'markdown',
  txt: 'text',
  text: 'text',
  rtf: 'text',
  csv: 'text',
};

const MIME_KINDS: Record<string, SourceKind> = {
  'application/pdf': 'pdf',
  'application/x-pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/markdown': 'markdown',
  'text/x-markdown': 'markdown',
  'text/plain': 'text',
  'text/csv': 'text',
};

/**
 * WHY the extension is consulted first and the bytes decide in the end: a browser reports
 * `application/octet-stream` for a .docx often enough that trusting the type alone loses
 * real uploads, and trusting the NAME alone lets a .pdf that is really a zip pick the
 * wrong reader. The magic-number check in `sniffKind` is what settles it.
 */
export function kindForName(filename: string, mimeType: string | null): SourceKind | null {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const byExt = EXTENSION_KINDS[ext];
  if (byExt !== undefined) return byExt;
  const mime = (mimeType ?? '').split(';')[0].trim().toLowerCase();
  const byMime = MIME_KINDS[mime];
  if (byMime !== undefined) return byMime;
  if (mime.startsWith('text/')) return 'text';
  return null;
}

/** What the first bytes actually say the file is, when they say anything at all. */
export function sniffKind(bytes: Uint8Array): SourceKind | null {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'pdf';
  }
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05)) {
    return 'docx';
  }
  return null;
}

/** Strips a path, a drive letter and anything that is not plainly part of a name. */
export function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').trim();
  return cleaned.length === 0 ? 'material' : cleaned.slice(0, 120);
}

/**
 * How many characters are normalized between yields to the event loop.
 *
 * WHY yield at all: a 2,000,000-character upload is the largest thing this process ever
 * puts through a string pipeline, and it runs in the SAME process that serves the UI and
 * the SSE generation stream. Done in one shot it is a few hundred milliseconds in which
 * nothing else on the loop runs at all — not a keystroke, not a token. In batches it costs
 * marginally more total CPU and stops being a freeze.
 */
const NORMALIZE_BATCH_CHARS = 64 * 1024;

/** Yields the loop for one turn, so whatever is already queued on it gets to run. */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * The character substitutions, applied to one line.
 *
 * Page breaks are deliberately not handled here: they become lines of their own in the
 * line pipeline, which is the whole point of the transform (see `normalizeSourceText`).
 */
function normalizeChars(line: string): string {
  return line
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-');
}

/**
 * The normalization, expressed as a fold over lines rather than a chain of whole-string
 * passes.
 *
 * WHY line-at-a-time: it is the only shape in which the work can be interrupted. Seven
 * chained `.replace()` calls over 2M characters are seven uninterruptible passes; this is
 * the same transform with an interior, so `normalizeSourceTextAsync` can stop between
 * batches and let the event loop breathe. The two collapses that used to be whole-string
 * regexes — a run of blank lines, and a word hyphenated across a line break — are carried
 * in the two fields below, so a batch boundary is never a place where the output differs.
 */
class LineNormalizer {
  private readonly out: string[] = [];
  /** The last content line, held back until we know whether the next one continues it. */
  private pending: string | null = null;
  private blankRun = 0;

  push(line: string): void {
    // A form feed stands on a line of its own: a PDF reader emits no newline around it,
    // so "...expectation.\fUnit 2" would otherwise be one line and hide the heading.
    const pieces = line.split(/[ \t]*\f[ \t]*/);
    for (let i = 0; i < pieces.length; i += 1) {
      if (i > 0) this.emit(PAGE_BREAK, false);
      this.emit(normalizeChars(pieces[i]), true);
    }
  }

  finish(): string {
    if (this.pending !== null) {
      this.flush(this.pending);
      this.pending = null;
    }
    return this.out.join('\n').trim();
  }

  /**
   * `joinable` is false for the page-break line itself, which is neither a candidate to be
   * joined onto nor a continuation of anything.
   */
  private emit(line: string, joinable: boolean): void {
    if (this.pending !== null) {
      // A PDF wraps mid-word with a hyphen at the end of a line. Left alone, "informa-
      // tion" is two words to every later stage, including the unit matcher. The hyphen
      // has to be the last character, exactly as the whole-string regex required.
      if (joinable && /[A-Za-z]-$/.test(this.pending) && /^[a-z]/.test(line)) {
        this.pending = `${this.pending.slice(0, -1)}${line}`;
        return;
      }
      this.flush(this.pending);
      this.pending = null;
    }
    if (joinable) {
      this.pending = line;
      return;
    }
    this.flush(line);
  }

  /** Writes a settled line, keeping at most one blank line out of any run of them. */
  private flush(line: string): void {
    const trimmed = line.replace(/[ \t]+$/, '');
    if (trimmed.length === 0) {
      this.blankRun += 1;
      if (this.blankRun > 1) return;
    } else {
      this.blankRun = 0;
    }
    this.out.push(trimmed);
  }
}

/** One newline convention, whatever the file arrived with. */
function toLines(raw: string): string[] {
  return raw.split(/\r\n?|\n/);
}

/**
 * Everything downstream — unit detection, chunking, the digest — assumes text that has
 * been through here: one newline convention, page breaks preserved as `\f` and standing
 * on a line of their own, no runs of blank lines, no zero-width or non-breaking oddities
 * from a word processor.
 *
 * WHY the page break gets a line to itself: a PDF reader emits no newline around it, so
 * "...expectation.\fUnit 2: Entropy" arrives as ONE line, and a unit that opens a new
 * page is then invisible to a matcher that reads a heading as a whole line. Every
 * syllabus long enough to matter starts a unit on a fresh page.
 *
 * This is the synchronous form, for input small enough that holding the loop does not
 * matter. Anything that may be handed a whole upload wants `normalizeSourceTextAsync`.
 */
export function normalizeSourceText(raw: string): string {
  const normalizer = new LineNormalizer();
  for (const line of toLines(raw)) normalizer.push(line);
  return normalizer.finish();
}

/**
 * `normalizeSourceText`, in batches, yielding the event loop between them.
 *
 * The output is character-for-character what the synchronous form returns — a batch edge
 * is a boundary in time, not in the transform.
 */
export async function normalizeSourceTextAsync(raw: string): Promise<string> {
  const lines = toLines(raw);
  const normalizer = new LineNormalizer();
  // Counted in characters rather than lines because line length is entirely up to the
  // document: a PDF that emits no line breaks at all would never reach a batch edge.
  let since = 0;
  for (let i = 0; i < lines.length; i += 1) {
    normalizer.push(lines[i]);
    since += lines[i].length + 1;
    if (since >= NORMALIZE_BATCH_CHARS) {
      since = 0;
      await yieldToEventLoop();
    }
  }
  return normalizer.finish();
}


export type Capped = { text: string; truncated: boolean };

/** WHY it returns the flag rather than just the text: a course cut short in silence is
 *  the failure this whole path exists to avoid. Every caller reports it onward. */
export function capSourceText(text: string, limit: number = MAX_SOURCE_CHARS): Capped {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}
