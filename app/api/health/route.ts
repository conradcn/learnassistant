// FRACTAL: implements F1 | component C9
import { route } from '@/api/respond';
import { healthView } from '@/api/health';

export const GET = route(async () => healthView(), { requiresStore: false });
