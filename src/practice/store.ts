// FRACTAL: implements F8 | component C7
import { practiceSessionSchema, type PracticeSession, type SessionId } from '@/shapes';
import { err } from '@/core/errors';

export type PracticeStore = {
  save(session: PracticeSession): PracticeSession;
  get(id: SessionId): PracticeSession | null;
  size(): number;
};

export const MAX_RETAINED_PRACTICE_SESSIONS = 32;

// WHY (bounded): practice sessions are short-lived working state; the newest
// window is retained and the oldest entry is evicted so a long-running process
// cannot grow this map without limit.
export function createPracticeStore(limit: number = MAX_RETAINED_PRACTICE_SESSIONS): PracticeStore {
  const rows = new Map<SessionId, PracticeSession>();
  return {
    save(session: PracticeSession): PracticeSession {
      const parsed = practiceSessionSchema.safeParse(session);
      if (!parsed.success) {
        throw err('validation', { detail: 'practice session failed shape validation' });
      }
      rows.delete(parsed.data.id);
      rows.set(parsed.data.id, parsed.data);
      while (rows.size > limit) {
        const oldest = rows.keys().next();
        if (oldest.done === true) break;
        rows.delete(oldest.value);
      }
      return parsed.data;
    },
    get(id: SessionId): PracticeSession | null {
      return rows.get(id) ?? null;
    },
    size(): number {
      return rows.size;
    },
  };
}
