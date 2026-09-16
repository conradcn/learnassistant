// FRACTAL: implements F14, F2 | component C9
import { moduleIdSchema } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseParam } from '@/api/validate';
import { err } from '@/core/errors';
import { importCardPack } from '@/cards/library';
import { locate } from '@/review/locate';

/**
 * "Add these to my cards". The pack is read from the lesson the learner is looking at and
 * never from the request body: the cards a lesson proposes were written by its authoring
 * session and checked on the way in, so letting the browser post its own list here would
 * turn a one-button import into an unvalidated write path into the library.
 */
export const POST = route<{ id: string }>(async (_req, params) => {
  const moduleId = parseParam(moduleIdSchema, params.id, 'lesson id');
  const store = requireStore().store;
  const located = locate(store, moduleId);
  if (located === null) {
    throw err('not-found', { detail: 'card pack requested for an unknown module', userMessage: 'We could not find that lesson.' });
  }
  const pack = located.node.content?.cardPack;
  if (pack === undefined) {
    throw err('not-found', {
      detail: 'card pack requested for a lesson that proposed none',
      userMessage: 'This lesson has no cards to add.',
    });
  }
  return importCardPack(store, pack, located.topic.id);
});
