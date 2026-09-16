// FRACTAL: covers F11 | type integration
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, closeStore, type Store } from '@/store/open';
import type { ModuleGraph, ModuleId, ModuleNode, Topic } from '@/shapes';
import {
  editReflection,
  reflectionQuoteForReview,
  saveReflection,
} from '@/reflect/journal';

const MODULE_ID = 'm_71bC0d9fQ2xK4mZa' as ModuleId;

const TRICKY_TEXT = [
  '  The *expectation* step is what I keep skipping — ',
  'especially when p(x) is tiny.\r\n',
  'Note: "log₂" still feels arbitrary. <b>not html</b> & \backslash 😅',
  '\n\ttrailing tab and spaces   ',
].join('');

function seedTopic(store: Store): Topic {
  const topic = store.topics.create({
    subject: 'Information theory',
    level: 'intermediate',
    purpose: 'read Shannon',
    diagnostic: null,
  });
  const node: ModuleNode = {
    id: MODULE_ID,
    topicId: topic.id,
    title: 'Entropy',
    ordinal: 0,
    kind: 'module',
    testOutEligible: false,
    estimatedMinutes: 20,
    state: 'available',
    content: null,
  };
  const graph: ModuleGraph = {
    topicId: topic.id,
    nodes: [node],
    edges: [],
    entryModules: [node.id],
  };
  store.modules.upsertGraph(graph);
  return topic;
}

describe('reflection quoted at review is byte-identical to what was stored', () => {
  let dataRoot: string;
  let store: Store;
  let topic: Topic;

  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-verbatim-'));
    store = openStore(dataRoot);
    topic = seedTopic(store);
  });

  afterEach(() => {
    closeStore(dataRoot);
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('hands C7 the exact bytes the learner typed, across a close and reopen', () => {
    saveReflection(store, { topicId: topic.id, moduleId: MODULE_ID, text: TRICKY_TEXT });

    closeStore(dataRoot);
    const reopened = openStore(dataRoot);

    const quoted = reflectionQuoteForReview(reopened, topic.id, MODULE_ID);
    expect(quoted).not.toBeNull();
    expect(quoted).toBe(TRICKY_TEXT);
    expect(Buffer.from(quoted as string, 'utf8').equals(Buffer.from(TRICKY_TEXT, 'utf8'))).toBe(true);
    expect(quoted).toContain('<b>not html</b>');
    expect(quoted).toMatch(/ {3}$/);
  });

  it('quotes the edited text verbatim, not the original', () => {
    const saved = saveReflection(store, {
      topicId: topic.id,
      moduleId: MODULE_ID,
      text: 'first draft',
    });
    const revised = `${TRICKY_TEXT}\n— revised`;
    editReflection(store, saved.id, revised);

    const quoted = reflectionQuoteForReview(store, topic.id, MODULE_ID);
    expect(quoted).toBe(revised);
    expect(Buffer.from(quoted as string, 'utf8').equals(Buffer.from(revised, 'utf8'))).toBe(true);
  });

  it('gives no callback text when the module has no reflection', () => {
    saveReflection(store, { topicId: topic.id, moduleId: null, text: 'topic-level only' });
    expect(reflectionQuoteForReview(store, topic.id, MODULE_ID)).toBeNull();
  });
});
