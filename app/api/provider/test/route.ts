// FRACTAL: implements F1, F6 | component C9
import { route } from '@/api/respond';
import { testProvider } from '@/api/provider';

// WHY POST for something that reads nothing: it spends a generation on the configured
// provider, so it must never be reachable by a link, a prefetch or a reload.
export const POST = route(async () => testProvider());
