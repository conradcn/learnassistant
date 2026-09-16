// FRACTAL: implements F1 | component C11
import { log } from '@/core/log';
import { MAX_SOURCE_CHARS, MAX_SOURCE_PAGES } from '@/shapes';

export type PdfText = {
  text: string;
  /** Pages actually READ, which is what the returned text covers. */
  pageCount: number;
  /** True when the document had more pages than we read. */
  truncated: boolean;
};

/**
 * The two ceilings on one read. Overridable only so a test can reach the character budget
 * without a fixture the size of a real book; production always takes the defaults.
 */
export type PdfLimits = { maxPages: number; maxChars: number };

export const DEFAULT_PDF_LIMITS: PdfLimits = {
  maxPages: MAX_SOURCE_PAGES,
  maxChars: MAX_SOURCE_CHARS,
};

/**
 * WHY the import is dynamic: pdf.js is a large ESM module and nothing but an actual PDF
 * upload needs it. Loading it lazily keeps it out of every route bundle that never sees
 * one, and keeps a failure to load it a failure of THIS extraction rather than of boot.
 */
async function pdfjs(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

/**
 * Reads the text out of a PDF in this process.
 *
 * WHY in-process and not a service: the material a learner brings is theirs, and sending
 * an assigned textbook to a parser someone else runs is a data egress the app does not
 * make anywhere else. pdf.js is pure JavaScript and does the whole job here — no OCR
 * binary, no upload, no network. The cost is that a PDF which is only PICTURES of text
 * yields nothing, which is a case the caller reports rather than papers over.
 *
 * Throws on a file that is not a readable PDF; returns empty text on one that is readable
 * and simply has no text in it. The two are different answers to the learner and are
 * therefore kept different here.
 *
 * The read is bounded twice: at `MAX_SOURCE_PAGES` pages, and at `MAX_SOURCE_CHARS`
 * characters counted AS the pages accumulate, so a document that is over the budget costs
 * only the pages it took to get there rather than the whole book. Either bound sets
 * `truncated`, which the caller reports to the learner — a course cut short in silence is
 * the failure this path exists to avoid.
 */
export async function extractPdfText(bytes: Uint8Array, limits: PdfLimits = DEFAULT_PDF_LIMITS): Promise<PdfText> {
  const lib = await pdfjs();
  const doc = await lib.getDocument({
    // WHY a copy: pdf.js transfers ownership of the buffer it is given and detaches it,
    // and the caller still needs those bytes to write the original to disk.
    data: new Uint8Array(bytes),
    // Nothing here renders, and every one of these switches off a code path that would
    // otherwise want a DOM, a font loader, or an eval.
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  }).promise;

  try {
    const pages: string[] = [];
    const pageLimit = Math.min(doc.numPages, limits.maxPages);
    let chars = 0;
    let pageNumber = 1;
    for (; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        let out = '';
        for (const item of content.items) {
          if (!('str' in item)) continue;
          out += item.str;
          if (item.hasEOL) out += '\n';
        }
        pages.push(out);
        chars += out.length + 1;
      } finally {
        page.cleanup();
      }
      // Checked after the page rather than before it: the budget is on what we KEEP, so a
      // document that fits exactly is never cut one page short of itself.
      if (chars >= limits.maxChars) {
        pageNumber += 1;
        break;
      }
    }
    const pagesRead = pageNumber - 1;
    const truncated = pagesRead < doc.numPages;
    if (truncated) {
      log({
        level: 'info',
        event: 'source-pdf-truncated',
        component: 'C11',
        pagesRead,
        totalPages: doc.numPages,
        chars,
      });
    }
    // A form feed is the page boundary the rest of C11 splits on; it survives
    // normalization and never appears in the text a syllabus actually contains.
    return { text: pages.join('\f'), pageCount: pagesRead, truncated };
  } finally {
    await doc.destroy().catch((cause: unknown) => {
      log({
        level: 'warn',
        event: 'source-pdf-destroy-failed',
        component: 'C11',
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    });
  }
}
