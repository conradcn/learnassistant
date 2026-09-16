// FRACTAL: implements F1 | component C11
import { assertNotInRelease } from '@/core/release';

assertNotInRelease('source/pdf.testing');

/**
 * A minimal, hand-written PDF writer.
 *
 * WHY it exists rather than a committed binary: the extraction tests need to say what is
 * IN the file they assert on, and the Playwright suite needs the same file to upload. A
 * few hundred bytes of uncompressed page content, built from one function both callers
 * import, keeps the fixture readable and keeps "what the PDF says" in the test that reads
 * it. It is a fixture writer, not a PDF library: no compression, no embedded fonts, one
 * base-14 font, which is exactly what a real text PDF's simplest case looks like.
 */

function escapeText(value: string): string {
  return value.replace(/[\\()]/g, (c) => `\\${c}`);
}

function assemble(objects: string[]): Buffer {
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets[i] = Buffer.byteLength(out, 'latin1');
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A PDF whose pages carry real, extractable text. One array entry is one page. */
export function textPdf(pages: string[][]): Buffer {
  const pageCount = Math.max(1, pages.length);
  // Object numbering: 1 catalog, 2 pages, 3 font, then (page, content) per page.
  const kids = Array.from({ length: pageCount }, (_v, i) => `${4 + i * 2} 0 R`).join(' ');
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  for (let i = 0; i < pageCount; i += 1) {
    const lines = pages[i] ?? [];
    const body = lines.map((line) => `(${escapeText(line)}) Tj T*`).join('\n');
    const content = `BT\n/F1 12 Tf\n72 720 Td\n16 TL\n${body}\nET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    objects.push(
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    );
  }
  return assemble(objects);
}

/**
 * A PDF that is a picture of a page: one image XObject, no text operators anywhere. This
 * is the shape a phone-camera or flatbed scan takes, and the case the app must refuse
 * plainly instead of proceeding with an empty extraction.
 */
export function scannedPdf(): Buffer {
  // A 2x2 greyscale image, drawn to fill the page. Nothing here is a text operator.
  const pixels = Buffer.from([0x00, 0xff, 0xff, 0x00]).toString('latin1');
  const content = 'q 612 0 0 792 0 0 cm /Im0 Do Q';
  return assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray ` +
      `/BitsPerComponent 8 /Length 4 >>\nstream\n${pixels}\nendstream`,
  ]);
}
