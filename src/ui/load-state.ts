// FRACTAL: implements F5 | component C10
import type { ApiResponse } from '@/shapes';
import type { LoadState } from '@/ui/shapes';

export type { LoadState };

export const LOADING: LoadState<never> = { status: 'loading' };

export function ready<T>(data: T): LoadState<T> {
  return { status: 'ready', data };
}

/**
 * WHY (H3): "nothing here yet" may only be produced from a successful response.
 * A failure can never reach the empty branch because the only path to `empty`
 * runs through `ok: true`.
 */
export function fromResponse<T>(response: ApiResponse<T>, isEmpty: (data: T) => boolean): LoadState<T> {
  if (!response.ok) return { status: 'error', error: response.error };
  return isEmpty(response.data) ? { status: 'empty' } : { status: 'ready', data: response.data };
}

export function fromListResponse<T>(response: ApiResponse<T[]>): LoadState<T[]> {
  return fromResponse(response, (rows) => rows.length === 0);
}
