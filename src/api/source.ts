// FRACTAL: implements F1 | component C9
import {
  MAX_SOURCE_BYTES,
  stagedSourceSchema,
  type SourceDocument,
  type SourceId,
  type StagedSource,
  type TopicId,
} from '@/shapes';
import { err } from '@/core/errors';
import { log } from '@/core/log';
import type { Store } from '@/store/open';
import { newSourceId } from '@/store/source';
import { extractPastedSource, extractSource, type ExtractionOutcome } from '@/source/extract';
import { detectLevelSignal, extractUnits, inferSubject } from '@/source/outline';
import { discardStaged, readStaged, stageSource, sweepStaging, writeSourceDocument } from '@/source/store';
import { safeFilename } from '@/source/text';
import { sourceDir } from '@/api/confine';

/** How much of the material the form shows back, so the learner can see we read it. */
const EXCERPT_CHARS = 400;

/**
 * WHY a failed extraction is a `validation` error and not an `internal` one: nothing went
 * wrong with the app. The learner handed us a scan, or a spreadsheet, or a file that is
 * not what its name says, and the answer is the one C11 wrote for that case — which names
 * the paste box, so the refusal comes with the way past it.
 */
function refuse(outcome: Extract<ExtractionOutcome, { ok: false }>): never {
  throw err('validation', {
    detail: `source extraction refused: ${outcome.reason}`,
    userMessage: outcome.message,
  });
}

function stagedFrom(id: SourceId, filename: string, outcome: Extract<ExtractionOutcome, { ok: true }>, byteSize: number): StagedSource {
  const units = extractUnits(outcome.text);
  return stagedSourceSchema.parse({
    id,
    filename,
    kind: outcome.kind,
    byteSize,
    charCount: outcome.text.length,
    pageCount: outcome.pageCount,
    truncated: outcome.truncated,
    units,
    inferredSubject: inferSubject(outcome.text),
    levelSignal: detectLevelSignal(outcome.text),
    excerpt: outcome.text.slice(0, EXCERPT_CHARS),
  });
}

/**
 * Reads one upload, in this process, and parks it until a topic claims it.
 *
 * Nothing here reaches the network: `extractSource` dispatches to a PDF reader, a DOCX
 * reader or a text decoder that all run in-process, and the subject and level it infers
 * are read with rules rather than with a model, so this costs nothing and works before a
 * provider has been configured at all.
 */
export async function stageUpload(
  dataRoot: string,
  bytes: Uint8Array,
  filename: string,
  mimeType: string | null,
): Promise<StagedSource> {
  sweepStaging(dataRoot);
  const outcome = await extractSource(bytes, filename, mimeType);
  if (!outcome.ok) refuse(outcome);

  const id = newSourceId();
  const staged = stagedFrom(id, safeFilename(filename), outcome, bytes.byteLength);
  stageSource(
    dataRoot,
    {
      id,
      filename: staged.filename,
      kind: staged.kind,
      byteSize: staged.byteSize,
      charCount: staged.charCount,
      pageCount: staged.pageCount,
      truncated: staged.truncated,
      units: staged.units,
    },
    outcome.text,
    bytes,
  );
  log({
    level: 'info',
    event: 'source-staged',
    component: 'C11',
    sourceId: id,
    kind: staged.kind,
    charCount: staged.charCount,
    unitCount: staged.units.length,
  });
  return staged;
}

/** The paste path: same normalization, same inference, no format to get wrong. */
export function stagePaste(dataRoot: string, text: string): StagedSource {
  sweepStaging(dataRoot);
  if (text.length > MAX_SOURCE_BYTES) {
    throw err('validation', { detail: 'pasted material exceeded the byte cap', userMessage: 'That is more text than we can take at once. Paste the syllabus or the chapter you need.' });
  }
  const outcome = extractPastedSource(text);
  if (!outcome.ok) refuse(outcome);

  const id = newSourceId();
  const staged = stagedFrom(id, 'Pasted material', outcome, Buffer.byteLength(text, 'utf8'));
  stageSource(
    dataRoot,
    {
      id,
      filename: staged.filename,
      kind: staged.kind,
      byteSize: staged.byteSize,
      charCount: staged.charCount,
      pageCount: staged.pageCount,
      truncated: staged.truncated,
      units: staged.units,
    },
    outcome.text,
    // Pasted text has no original beyond the text itself; keeping a second copy of it
    // under a different name would be storing the learner's material twice.
    null,
  );
  return staged;
}

/**
 * Moves everything the learner attached at intake from staging into the topic that now
 * owns it — the extracted text and the original upload onto disk under
 * `<dataRoot>/topics/<topic>/source/`, one row each into the index.
 *
 * WHY a staged id that has gone missing is skipped rather than refused: the topic has
 * already been created by the time this runs, and failing here would leave the learner
 * with a subject and no way to retry the upload. The course runs on the material that
 * survived, which is the same path a learner who uploaded nothing takes.
 */
export function attachSources(
  store: Store,
  dataRoot: string,
  topicId: TopicId,
  sourceIds: SourceId[],
  pastedMaterial: string,
): SourceDocument[] {
  // Asserts the confinement before a single byte is written, so a topic id that could
  // resolve outside the topics root fails before it has left anything behind.
  sourceDir(dataRoot, topicId);
  const attached: SourceDocument[] = [];

  for (const sourceId of sourceIds) {
    const record = readStaged(dataRoot, sourceId);
    if (record === null) {
      log({ level: 'warn', event: 'source-staged-missing', component: 'C9', topicId, sourceId });
      continue;
    }
    writeSourceDocument(dataRoot, topicId, { ...record.meta, id: sourceId }, record.text, record.original);
    attached.push(store.sources.add({ ...record.meta, id: sourceId, topicId }));
    discardStaged(dataRoot, sourceId);
  }

  // WHY the paste box is also read here and not only through staging: a learner who types
  // into it and presses "Add it" without first pressing the button that reads it back has
  // still told us what they are studying. Losing it because they skipped a step would be
  // the app being pedantic with someone's own syllabus.
  const pasted = pastedMaterial.trim();
  if (pasted.length > 0) {
    const outcome = extractPastedSource(pasted);
    if (outcome.ok) {
      const id = newSourceId();
      const units = extractUnits(outcome.text);
      const record = {
        id,
        filename: 'Pasted material',
        kind: outcome.kind,
        byteSize: Buffer.byteLength(pasted, 'utf8'),
        charCount: outcome.text.length,
        pageCount: outcome.pageCount,
        truncated: outcome.truncated,
        units,
      };
      writeSourceDocument(dataRoot, topicId, record, outcome.text, null);
      attached.push(store.sources.add({ ...record, topicId }));
    }
  }

  if (attached.length > 0) {
    log({
      level: 'info',
      event: 'source-attached',
      component: 'C9',
      topicId,
      documents: attached.length,
      unitCount: attached.reduce((n, d) => n + d.units.length, 0),
    });
  }
  return attached;
}

