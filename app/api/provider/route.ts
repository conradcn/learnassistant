// FRACTAL: implements F1, F6 | component C9
import { route } from '@/api/respond';
import { parseBody } from '@/api/validate';
import { providerUpdateSchema } from '@/shapes';
import { providerView, updateProvider } from '@/api/provider';

export const GET = route(async () => providerView());

export const POST = route(async (req) => {
  const body = await parseBody(req, providerUpdateSchema);
  return updateProvider(body);
});
