// FRACTAL: covers F11 | type unit
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, closeStore, type Store } from '@/store/open';
import { exampleModuleId, exampleReflection, exampleTopicId, reflectionSchema, type ModuleId } from '@/shapes';
import { AppError } from '@/core/errors';
import {
  REFLECTION_SAVE_FAILED_MESSAGE,
  deleteReflection,
  editReflection,
  reflectionFor,
  reflectionQuoteForReview,
  reflectionsForTopic,
  saveReflection,
} from '@/reflect/journal';

const deletedModuleId = 'm_0d9fQ2xK4mZa71bC' as ModuleId;

describe('reflection journal', () => {
  let dataRoot: string;
  let store: Store;

  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-journal-'));
    store = openStore(dataRoot);
  });

  afterEach(() => {
    closeStore(dataRoot);
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('saves a reflection and surfaces it for its module (happy path)', () => {
    const saved = saveReflection(store, {
      topicId: exampleTopicId,
      moduleId: exampleModuleId,
      text: exampleReflection.text,
    });
    expect(reflectionSchema.safeParse(saved).success).toBe(true);
    expect(saved.text).toBe(exampleReflection.text);

    const found = reflectionFor(store, exampleTopicId, exampleModuleId);
    expect(found?.id).toBe(saved.id);
    expect(reflectionQuoteForReview(store, exampleTopicId, exampleModuleId)).toBe(
      exampleReflection.text,
    );
  });

  it('returns null when no reflection was written, so review proceeds without a callback', () => {
    expect(reflectionFor(store, exampleTopicId, exampleModuleId)).toBeNull();
    expect(reflectionQuoteForReview(store, exampleTopicId, exampleModuleId)).toBeNull();
    expect(reflectionsForTopic(store, exampleTopicId)).toEqual([]);
  });

  it('surfaces the latest version after an edit', () => {
    const saved = saveReflection(store, {
      topicId: exampleTopicId,
      moduleId: exampleModuleId,
      text: 'First thoughts.',
    });
    const edited = editReflection(store, saved.id, 'Second thoughts, which are the real ones.');
    expect(edited.id).toBe(saved.id);
    expect(edited.text).toBe('Second thoughts, which are the real ones.');

    expect(reflectionQuoteForReview(store, exampleTopicId, exampleModuleId)).toBe(
      'Second thoughts, which are the real ones.',
    );
    expect(reflectionsForTopic(store, exampleTopicId)).toHaveLength(1);
  });

  it('keeps a topic-level reflection visible when its module was deleted', () => {
    const orphan = saveReflection(store, {
      topicId: exampleTopicId,
      moduleId: deletedModuleId,
      text: 'That module never clicked.',
    });
    expect(store.modules.graph(exampleTopicId).nodes).toEqual([]);
    const onTopic = reflectionsForTopic(store, exampleTopicId);
    expect(onTopic.map((r) => r.id)).toContain(orphan.id);

    deleteReflection(store, orphan.id);
    expect(reflectionsForTopic(store, exampleTopicId)).toEqual([]);
  });

  it('surfaces a save failure with the learner-facing message and stores nothing', () => {
    const brokenStore = {
      ...store,
      reflections: {
        ...store.reflections,
        create: () => {
          throw new Error('disk gone');
        },
      },
    } as unknown as Store;

    let caught: unknown;
    try {
      saveReflection(brokenStore, {
        topicId: exampleTopicId,
        moduleId: exampleModuleId,
        text: 'Still in the textarea.',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).message).toBe(REFLECTION_SAVE_FAILED_MESSAGE);
    expect((caught as AppError).correlationId).toMatch(/^c_/);
    expect(reflectionsForTopic(store, exampleTopicId)).toEqual([]);
  });

  it('reports an edit of a reflection that no longer exists as not found', () => {
    let caught: unknown;
    try {
      editReflection(store, 'r_missing', 'anything');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('not-found');
  });

  it('rejects a malformed topic id rather than writing it', () => {
    expect(() =>
      saveReflection(store, { topicId: 'not-a-topic' as never, moduleId: null, text: 'x' }),
    ).toThrowError(REFLECTION_SAVE_FAILED_MESSAGE);
  });
});
