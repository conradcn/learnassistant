// FRACTAL: implements F3 | component C8
import type { ModuleId, TopicId, WarmUpRecord } from '@/shapes';
import type { Store } from '@/store/open';
import { log } from '@/core/log';
import { warmUpFromNotes } from '@/reflect/warm-up';

export function warmUpFor(store: Store, topicId: TopicId, moduleId: ModuleId): WarmUpRecord | null {
  try {
    const notes = store.reflections
      .listByTopic(topicId)
      .filter((r) => r.moduleId === moduleId)
      .map((r) => r.text);
    return warmUpFromNotes(notes);
  } catch (e) {
    log({
      level: 'warn',
      event: 'warm-up-read-failed',
      component: 'C8',
      moduleId,
      detail: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
