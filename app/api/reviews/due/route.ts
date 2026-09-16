// FRACTAL: implements F7 | component C9
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { due } from '@/review/queue';
import { toCue } from '@/review/cue';

// WHY cues and not items: `ReviewItem` carries the FSRS memory state, and F5 forbids
// progress expressed as anything score-like. Stability, difficulty and retrievability are
// exactly the numbers a dashboard grows around if they are within reach of one, so they do
// not cross this boundary at all. See `docs/spaced-repetition.md` §5.
export const GET = route(async () => due(requireStore().store).map(toCue));
