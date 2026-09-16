// FRACTAL: implements F1, F5 | component C9
import { route } from '@/api/respond';
import { requireStore } from '@/api/services';
import { queueView } from '@/api/queue';

export const GET = route(async () => queueView(requireStore()));
