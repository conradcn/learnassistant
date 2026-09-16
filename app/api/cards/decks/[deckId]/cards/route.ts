// FRACTAL: implements F14 | component C9
import { z } from 'zod';
import { deckIdSchema, newCardSchema } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseBody, parseParam } from '@/api/validate';
import { addCards } from '@/cards/library';
import { IMPORT_LINE_CAP, parseCardImport } from '@/cards/parse';

/**
 * One card typed in, or a whole list pasted. The paste is read here rather than in the
 * browser so the same rules apply however the cards arrive.
 */
const bodySchema = z
  .union([
    z.object({ card: newCardSchema }).strict(),
    z.object({ paste: z.string().min(1).max(200_000) }).strict(),
  ]);

export const POST = route<{ deckId: string }>(async (req, params) => {
  const deckId = parseParam(deckIdSchema, params.deckId, 'deck id');
  const body = await parseBody(req, bodySchema);
  const store = requireStore().store;
  if ('card' in body) {
    return { cards: addCards(store, deckId, [body.card]), skipped: [] as string[] };
  }
  const parsed = parseCardImport(body.paste);
  if (parsed.cards.length === 0) {
    return { cards: [], skipped: parsed.skipped.slice(0, IMPORT_LINE_CAP) };
  }
  return { cards: addCards(store, deckId, parsed.cards), skipped: parsed.skipped.slice(0, IMPORT_LINE_CAP) };
});
