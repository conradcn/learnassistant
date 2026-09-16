// FRACTAL: implements F11 | component C8
import { newReflectionSchema, type ModuleId, type NewReflection, type Reflection, type TopicId } from '@/shapes';
import type { Store } from '@/store/open';
import { AppError, err } from '@/core/errors';
import { log } from '@/core/log';

export type { NewReflection } from '@/shapes';

export const REFLECTION_SAVE_FAILED_MESSAGE = 'Could not save — your text is still here.';

function saveFailure(e: unknown, event: string, ids: Record<string, unknown>): AppError {
  if (e instanceof AppError && e.code === 'not-found') return e;
  log({
    level: 'warn',
    event,
    component: 'C8',
    ...ids,
    detail: e instanceof Error ? e.message : String(e),
  });
  return err('internal', {
    detail: 'reflection write failed',
    userMessage: REFLECTION_SAVE_FAILED_MESSAGE,
  });
}

export function saveReflection(store: Store, input: NewReflection): Reflection {
  const parsed = newReflectionSchema.safeParse(input);
  if (!parsed.success) {
    throw err('validation', {
      detail: 'reflection input failed shape validation',
      userMessage: REFLECTION_SAVE_FAILED_MESSAGE,
    });
  }
  try {
    const saved = store.reflections.create(parsed.data);
    log({
      level: 'info',
      event: 'reflection-saved',
      component: 'C8',
      reflectionId: saved.id,
      topicId: saved.topicId,
      moduleId: saved.moduleId,
    });
    return saved;
  } catch (e) {
    throw saveFailure(e, 'reflection-save-failed', { topicId: parsed.data.topicId });
  }
}

export function editReflection(store: Store, id: string, text: string): Reflection {
  if (typeof text !== 'string') {
    throw err('validation', {
      detail: 'reflection text must be a string',
      userMessage: REFLECTION_SAVE_FAILED_MESSAGE,
    });
  }
  try {
    const updated = store.reflections.update(id, text);
    log({ level: 'info', event: 'reflection-edited', component: 'C8', reflectionId: id });
    return updated;
  } catch (e) {
    throw saveFailure(e, 'reflection-edit-failed', { reflectionId: id });
  }
}

export function deleteReflection(store: Store, id: string): void {
  store.reflections.delete(id);
  log({ level: 'info', event: 'reflection-deleted', component: 'C8', reflectionId: id });
}

export function reflectionsForTopic(store: Store, topicId: TopicId): Reflection[] {
  return store.reflections.listByTopic(topicId);
}

function latest(reflections: Reflection[]): Reflection | null {
  if (reflections.length === 0) return null;
  return reflections.reduce((best, r) => {
    if (r.updatedAt > best.updatedAt) return r;
    if (r.updatedAt === best.updatedAt && r.createdAt > best.createdAt) return r;
    return best;
  });
}

export function reflectionFor(store: Store, topicId: TopicId, moduleId: ModuleId): Reflection | null {
  const forModule = reflectionsForTopic(store, topicId).filter((r) => r.moduleId === moduleId);
  return latest(forModule);
}

export function reflectionQuoteForReview(
  store: Store,
  topicId: TopicId,
  moduleId: ModuleId,
): string | null {
  const reflection = reflectionFor(store, topicId, moduleId);
  return reflection === null ? null : reflection.text;
}
