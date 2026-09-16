// FRACTAL: covers F3 | type integration
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, closeStore, type Store } from '@/store/open';
import { exampleModuleId, exampleTopicId, type ModuleId } from '@/shapes';
import { WARM_UP_SKIP_NOTE, warmUpFromNotes, warmUpNote } from '@/reflect/warm-up';
import { warmUpFor } from '@/reflect/warm-up-history';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'la-warmup-'));
  store = openStore(dir);
});

afterEach(() => {
  closeStore(dir);
  rmSync(dir, { recursive: true, force: true });
});

describe('the warm-up a learner already had a go at', () => {
  it('reads the first go back out of the note it was written into', () => {
    expect(warmUpFromNotes([warmUpNote('three questions')])).toEqual({
      stage: 'attempted',
      text: 'three questions',
    });
  });

  it('has nothing to show for a lesson that was never opened, or for unrelated notes', () => {
    expect(warmUpFromNotes([])).toBeNull();
    expect(warmUpFromNotes(['Started this lesson before finishing Logarithms.'])).toBeNull();
  });

  it('shows the latest go, so a second visit does not resurrect the first', () => {
    expect(warmUpFromNotes([warmUpNote('a guess'), WARM_UP_SKIP_NOTE, warmUpNote('a better guess')])).toEqual({
      stage: 'attempted',
      text: 'a better guess',
    });
  });

  it('survives the round trip through the store, and stays scoped to its own lesson', () => {
    const other = 'm_0d9fQ2xK4mZa71bC' as ModuleId;
    store.reflections.create({ topicId: exampleTopicId, moduleId: exampleModuleId, text: warmUpNote('mine') });
    store.reflections.create({ topicId: exampleTopicId, moduleId: other, text: warmUpNote('someone else lesson') });

    expect(warmUpFor(store, exampleTopicId, exampleModuleId)).toEqual({ stage: 'attempted', text: 'mine' });
    expect(warmUpFor(store, exampleTopicId, other)).toEqual({ stage: 'attempted', text: 'someone else lesson' });
  });

  it('remembers a deliberate skip as a skip and not as an empty answer', () => {
    store.reflections.create({ topicId: exampleTopicId, moduleId: exampleModuleId, text: WARM_UP_SKIP_NOTE });
    expect(warmUpFor(store, exampleTopicId, exampleModuleId)).toEqual({ stage: 'skipped', text: '' });
  });
});
