// FRACTAL: implements F3, F4, F5, F10, F11 | component C10
'use client';
import { useSyncExternalStore } from 'react';
import type { DashboardView, EvalSession, ModuleAvailability, ModuleGraph } from '@/shapes';
import type { AppStoreState, PendingOp } from '@/ui/shapes';

export type { AppStoreState, PendingOp };

function initialState(): AppStoreState {
  return {
    dashboard: null,
    topic: null,
    evalSession: null,
    pending: [],
  };
}

let state: AppStoreState = initialState();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function commit(next: AppStoreState): void {
  state = next;
  emit();
}

export function getAppState(): AppStoreState {
  return state;
}

export function subscribeAppStore(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/** The single read hook every page uses; the snapshot is replaced, never mutated. */
export function useAppStore(): AppStoreState {
  return useSyncExternalStore(subscribeAppStore, getAppState, getAppState);
}

export function setDashboard(dashboard: DashboardView | null): void {
  commit({ ...state, dashboard });
}

export function setTopic(topic: { graph: ModuleGraph; availability: ModuleAvailability[] } | null): void {
  commit({ ...state, topic });
}

export function setEvalSession(evalSession: EvalSession | null): void {
  commit({ ...state, evalSession });
}

export function addPending(op: PendingOp): void {
  commit({ ...state, pending: [...state.pending, op] });
}

export function removePending(id: string): void {
  commit({ ...state, pending: state.pending.filter((op) => op.id !== id) });
}

export function resetAppStore(): void {
  state = initialState();
  emit();
}
