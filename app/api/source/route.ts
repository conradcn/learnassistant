// FRACTAL: implements F1 | component C9
import { MAX_SOURCE_BYTES, MAX_SOURCE_CHARS } from '@/shapes';
import { z } from 'zod';
import { err } from '@/core/errors';
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseValue } from '@/api/validate';
import { stagePaste, stageUpload } from '@/api/source';

const pasteSchema = z.object({ text: z.string().min(1).max(MAX_SOURCE_CHARS) });

/**
 * Reads one piece of material and hands back what it says about itself, so the intake form
 * can pre-fill the subject before there is a topic to file the material under.
 *
 * WHY the two shapes share one route: they are one operation — "read this material" — and
 * they differ only in how the bytes arrived. `extractSource` is already the single door
 * every upload comes through; a second endpoint would put a second door beside it.
 *
 * Nothing here dispatches a session. Extraction and the subject it infers are local and
 * free, which is why this can run while the learner is still filling in the form.
 */
export const POST = route(async (req) => {
  const dataRoot = requireStore().dataRoot;
  const contentType = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();

  if (contentType === 'application/json') {
    const body = parseValue(pasteSchema, JSON.parse(await req.text()), 'request body');
    return stagePaste(dataRoot, body.text);
  }

  if (contentType !== 'multipart/form-data') {
    throw err('validation', {
      detail: `source upload had unusable content type "${contentType}"`,
      userMessage: 'We could not read that upload. Try choosing the file again.',
    });
  }

  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    throw err('validation', { detail: 'source upload carried no file part', userMessage: 'Choose a file to upload first.' });
  }
  // WHY the size is refused before the body is read into memory: the declared size is the
  // cheapest thing to check, and reading 400 MB to then say no is the same as not saying
  // no. `extractSource` checks the real length again on what actually arrived.
  if (file.size > MAX_SOURCE_BYTES) {
    throw err('validation', {
      detail: 'source upload exceeded the byte cap',
      userMessage: 'That file is bigger than 25 MB. Upload the syllabus or the chapters you need, or paste the text instead.',
    });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  return stageUpload(dataRoot, bytes, file.name, file.type === '' ? null : file.type);
});
