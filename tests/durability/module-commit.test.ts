// FRACTAL: covers F2 | type integration
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exampleModuleContent, exampleTopicIntakeRequest, moduleContentSchema, type ModuleNode } from '@/shapes';
import { resetConfigCache, saveConfig } from '@/core/config';
import { AppError } from '@/core/errors';
import { openStore, closeStore, type Store } from '@/store/open';
import type { NewTopic } from '@/store/topics';
import { newModuleId } from '@/orchestrator/ids';
import {
  CONTENT_FILE,
  commitModule,
  contentDigest,
  discardOrphanDirectory,
  moduleDirFor,
  readContentFile,
  reconcileTopic,
  writeContentFile,
} from '@/orchestrator/reconcile';
import { CONTENT_VERSION } from '@/orchestrator/content-validate';

const intake: NewTopic = {
  subject: exampleTopicIntakeRequest.subject,
  level: exampleTopicIntakeRequest.level,
  purpose: exampleTopicIntakeRequest.purpose,
  diagnostic: null,
};

const content = moduleContentSchema.parse(exampleModuleContent);

let dataRoot: string;
let store: Store;

function makeNode(topicId: ReturnType<Store['topics']['create']>['id']): ModuleNode {
  return {
    id: newModuleId(),
    topicId,
    title: 'Entropy as expected surprise',
    ordinal: 1,
    kind: 'module',
    testOutEligible: false,
    estimatedMinutes: 20,
    state: 'available',
    content: null,
  };
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-commit-'));
  process.env.LA_DATA_ROOT = dataRoot;
  resetConfigCache();
  saveConfig({
    dataRoot,
    claudeBin: 'claude',
  });
  store = openStore(dataRoot);
});

afterEach(() => {
  closeStore(dataRoot);
  delete process.env.LA_DATA_ROOT;
  resetConfigCache();
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('committing a module', () => {
  it('writes content.json first and the row second, and both survive a reopen', () => {
    const topic = store.topics.create(intake);
    const node = makeNode(topic.id);
    commitModule(store, dataRoot, node, content);

    const file = path.join(moduleDirFor(dataRoot, topic.id, node.id), CONTENT_FILE);
    expect(existsSync(file)).toBe(true);
    const envelope: unknown = JSON.parse(readFileSync(file, 'utf8'));
    expect(envelope).toMatchObject({ contentVersion: CONTENT_VERSION, digest: contentDigest(content) });

    const row = store.modules.graph(topic.id).nodes.find((n) => n.id === node.id);
    expect(row?.content).not.toBeNull();
    expect(row?.content?.learningGoals).toEqual(content.learningGoals);
  });

  it('keeps exactly one prior generation of content.json when rewritten', () => {
    const topic = store.topics.create(intake);
    const node = makeNode(topic.id);
    writeContentFile(dataRoot, topic.id, node.id, content);
    const rewritten = { ...content, learningGoals: ['A second pass at the same lesson'] };
    writeContentFile(dataRoot, topic.id, node.id, moduleContentSchema.parse(rewritten));

    const dir = moduleDirFor(dataRoot, topic.id, node.id);
    expect(existsSync(path.join(dir, `${CONTENT_FILE}.prev`))).toBe(true);
    expect(existsSync(path.join(dir, `${CONTENT_FILE}.tmp`))).toBe(false);
    const load = readContentFile(dataRoot, topic.id, node.id);
    expect(load.ok).toBe(true);
    if (!load.ok) throw new Error(load.degradedReason);
    expect(load.content.learningGoals).toEqual(rewritten.learningGoals);
  });

  it('refuses to write content past the 1 MB cap', () => {
    const topic = store.topics.create(intake);
    const node = makeNode(topic.id);
    const huge = moduleContentSchema.parse({
      ...content,
      explanation: { kind: 'text', markdown: 'x'.repeat(1024 * 1024 + 64) },
    });
    expect(() => writeContentFile(dataRoot, topic.id, node.id, huge)).toThrow(AppError);
  });
});

describe('two module commits for the same topic overlapping', () => {
  // WHY the hook: the orchestrator fans module tasks out unbounded, so a second commit can
  // land in the middle of the first. Driving that interleaving from the hook makes the race
  // deterministic instead of hoping the scheduler reproduces it.
  it('keeps the content of both modules — neither commit reverts the other', () => {
    const topic = store.topics.create(intake);
    const first = makeNode(topic.id);
    const second = { ...makeNode(topic.id), ordinal: 2, title: 'Cross-entropy and coding cost' };
    store.modules.upsertGraph({
      topicId: topic.id,
      nodes: [first, second],
      edges: [{ from: first.id, to: second.id }],
      entryModules: [first.id],
    });

    const secondContent = moduleContentSchema.parse({
      ...exampleModuleContent,
      learningGoals: ['Measure the coding cost of the wrong model'],
    });
    commitModule(store, dataRoot, first, content, {
      // the interleaved task: it read the graph before this commit's row landed
      afterFileBeforeRow: () => {
        commitModule(store, dataRoot, second, secondContent);
      },
    });

    const graph = store.modules.graph(topic.id);
    expect(graph.nodes.find((n) => n.id === first.id)?.content).not.toBeNull();
    expect(graph.nodes.find((n) => n.id === second.id)?.content?.learningGoals).toEqual(
      secondContent.learningGoals,
    );
    // the commit touches rows only, so the topic's shape is left as generation planned it
    expect(graph.edges).toEqual([{ from: first.id, to: second.id }]);
    expect(graph.entryModules).toEqual([first.id]);
  });
});

describe('interrupted between content.json and the module row', () => {
  it('never leaves a row the reader silently skips — the directory is simply invisible', () => {
    const topic = store.topics.create(intake);
    const node = makeNode(topic.id);
    expect(() =>
      commitModule(store, dataRoot, node, content, {
        afterFileBeforeRow: () => {
          throw new Error('power cut');
        },
      }),
    ).toThrow(/power cut/);

    expect(store.modules.graph(topic.id).nodes.find((n) => n.id === node.id)).toBeUndefined();
    expect(existsSync(path.join(moduleDirFor(dataRoot, topic.id, node.id), CONTENT_FILE))).toBe(true);
  });

  it('is rebuilt by the reconcile sweep when the digest validates', () => {
    const topic = store.topics.create(intake);
    const node = makeNode(topic.id);
    try {
      commitModule(store, dataRoot, node, content, {
        afterFileBeforeRow: () => {
          throw new Error('power cut');
        },
      });
    } catch {
      // the interruption under test — the sweep below is the recovery
    }

    const outcome = reconcileTopic(store, dataRoot, topic.id);
    expect(outcome.orphanDirectories).toEqual([node.id]);
    expect(outcome.rebuiltFromDisk).toEqual([node.id]);

    const row = store.modules.graph(topic.id).nodes.find((n) => n.id === node.id);
    expect(row).toBeDefined();
    expect(row?.content?.learningGoals).toEqual(content.learningGoals);
  });

  it('refuses to promote a half-written file, reporting it as degraded instead', () => {
    const topic = store.topics.create(intake);
    const node = makeNode(topic.id);
    writeContentFile(dataRoot, topic.id, node.id, content);
    const file = path.join(moduleDirFor(dataRoot, topic.id, node.id), CONTENT_FILE);
    const truncated = readFileSync(file, 'utf8').slice(0, 40);
    writeFileSync(file, truncated);

    const outcome = reconcileTopic(store, dataRoot, topic.id);
    expect(outcome.rebuiltFromDisk).toEqual([]);
    expect(outcome.orphanDirectories).toEqual([node.id]);
    expect(outcome.degraded[0]?.moduleId).toBe(node.id);
    expect(outcome.degraded[0]?.reason).toMatch(/damaged/);
    expect(store.modules.graph(topic.id).nodes.find((n) => n.id === node.id)).toBeUndefined();

    discardOrphanDirectory(dataRoot, topic.id, node.id);
    expect(existsSync(moduleDirFor(dataRoot, topic.id, node.id))).toBe(false);
  });
});

describe('a row whose content is gone', () => {
  it('is reported as needing attention rather than rendering as an empty lesson', () => {
    const topic = store.topics.create(intake);
    const node = makeNode(topic.id);
    commitModule(store, dataRoot, node, content);
    rmSync(moduleDirFor(dataRoot, topic.id, node.id), { recursive: true, force: true });

    const outcome = reconcileTopic(store, dataRoot, topic.id);
    expect(outcome.missingContent).toEqual([node.id]);
    expect(outcome.degraded.find((d) => d.moduleId === node.id)?.reason).toMatch(/not been written/);
    const load = readContentFile(dataRoot, topic.id, node.id);
    expect(load.ok).toBe(false);
  });
});

describe('the module directory sink', () => {
  it('confines every resolved module directory under the topics root', () => {
    const topic = store.topics.create(intake);
    const node = makeNode(topic.id);
    const dir = moduleDirFor(dataRoot, topic.id, node.id);
    expect(path.resolve(dir).startsWith(path.resolve(dataRoot))).toBe(true);
    expect(dir).toContain(topic.id);
    expect(dir).toContain(node.id);
  });

  it('writes the lesson file with owner-only permissions on POSIX', () => {
    const topic = store.topics.create(intake);
    const node = makeNode(topic.id);
    writeContentFile(dataRoot, topic.id, node.id, content);
    if (process.platform === 'win32') {
      expect(existsSync(path.join(moduleDirFor(dataRoot, topic.id, node.id), CONTENT_FILE))).toBe(true);
      return;
    }
    const mode = statSync(path.join(moduleDirFor(dataRoot, topic.id, node.id), CONTENT_FILE)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(statSync(moduleDirFor(dataRoot, topic.id, node.id)).mode & 0o777).toBe(0o700);
  });
});
