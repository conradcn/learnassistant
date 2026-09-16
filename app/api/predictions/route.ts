// FRACTAL: implements F1 | component C9
import { predictionSchema } from '@/shapes';
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseBody } from '@/api/validate';
import { recordPrediction } from '@/reflect/prediction';

export const POST = route(async (req) => recordPrediction(requireStore().store, await parseBody(req, predictionSchema)));
