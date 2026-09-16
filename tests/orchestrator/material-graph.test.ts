// FRACTAL: covers F2 | type integration
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exampleModuleContent, type ModuleGraph, type Topic } from '@/shapes';
import { resetConfigCache, saveConfig } from '@/core/config';
import { closeStore, openStore, type Store } from '@/store/open';
import type { NewTopic } from '@/store/topics';
import { newSourceId } from '@/store/source';
import { writeSourceDocument } from '@/source/store';
import { resetMaterialCache } from '@/source/material';
import { SessionRunner } from '@/cli/run-session';
import { KindTransport } from '@/orchestrator/transport.kind';
import { createOrchestrator, type Orchestrator } from '@/orchestrator/engine';
import { estimateModules, planFor } from '@/orchestrator/plan';
import { readTopicState } from '@/orchestrator/topic-state';

const intake: NewTopic = {
  subject: 'Information theory',
  level: 'intermediate',
  purpose: 'build a compressor',
  diagnostic: null,
};

/** A syllabus of the shape a department hands out: a title, then its units in order. */
const UNITS = [
  'Probability review',
  'Entropy',
  'Source coding',
  'Channel capacity',
  'Error-correcting codes',
];

const SYLLABUS = [
  'Course: Information Theory',
  '',
  ...UNITS.map((title, i) => `Unit ${i + 1}: ${title}\nWhat this unit covers, in the words of the course.`),
].join('\n\n');

let dataRoot: string;
let store: Store;
let runner: SessionRunner | undefined;
let orchestrator: Orchestrator | undefined;

/** Whatever the research session returns, for the topic under test. */
type Outline = { drivingQuestion: string; modules: { id: string; title: string; objectives: string[] }[]; edges: { from: string; to: string }[] };

function boot(outline: Outline): void {
  runner = new SessionRunner({
    transport: new KindTransport({
      responder: (kind: string): unknown => {
        if (kind === 'generate-topic') return outline;
        if (kind === 'capstone-spec') return { spec: 'Build a compressor and justify every choice.' };
        if (kind === 'discontinuity-review') return { issues: [] };
        return { ...exampleModuleContent, explanation: { kind: 'text', markdown: 'Written for the test.' } };
      },
    }),
  });
  orchestrator = createOrchestrator({ store, runner, dataRoot });
}

/** Material on disk and in the index, exactly as `attachSources` leaves it at intake. */
function attachSyllabus(topic: Topic, text = SYLLABUS): void {
  const id = newSourceId();
  const record = {
    id,
    filename: 'syllabus.txt',
    kind: 'text' as const,
    byteSize: Buffer.byteLength(text, 'utf8'),
    charCount: text.length,
    pageCount: null,
    truncated: false,
    units: [] as { label: string; title: string }[],
  };
  writeSourceDocument(dataRoot, topic.id, record, text, null);
  store.sources.add({ ...record, topicId: topic.id });
  resetMaterialCache();
}

/** An outline that names none of the syllabus's units, which is the case worth testing. */
function outlineOf(titles: string[]): Outline {
  const modules = titles.map((title, i) => ({ id: `n${i}`, title, objectives: [`Explain ${title}`] }));
  return {
    drivingQuestion: 'How much can a message be squeezed?',
    modules,
    edges: modules.slice(1).map((m) => ({ from: modules[0].id, to: m.id })),
  };
}

async function generate(topic: Topic): Promise<ModuleGraph> {
  orchestrator!.enqueueTopic(topic.id);
  await orchestrator!.drain();
  orchestrator!.resumeGeneration(topic.id);
  await orchestrator!.drain();
  return store.modules.graph(topic.id);
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-material-graph-'));
  process.env.LA_DATA_ROOT = dataRoot;
  resetConfigCache();
  saveConfig({ dataRoot, claudeBin: 'claude' });
  resetMaterialCache();
  runner = undefined;
  orchestrator = undefined;
  store = openStore(dataRoot);
});

afterEach(async () => {
  // The plan tests are pure and never boot one.
  await orchestrator?.close();
  await runner?.close();
  closeStore(dataRoot);
  resetMaterialCache();
  delete process.env.LA_DATA_ROOT;
  resetConfigCache();
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('the plan a syllabus makes room for', () => {
  it('raises the module count to at least the number of units the material names', () => {
    const plain = estimateModules(intake);

    expect(estimateModules(intake, 3)).toBe(plain);
    expect(estimateModules(intake, plain + 6)).toBe(plain + 6);
    expect(planFor(intake, plain + 6).estimatedModules).toBe(plain + 6);
    // A count over the cap is still a course and not a lifetime.
    expect(estimateModules(intake, 400)).toBe(60);
  });

  it('leaves a topic that brought nothing on exactly the estimate it always had', () => {
    expect(planFor(intake, 0)).toEqual(planFor(intake));
  });
});

describe('material constrains the graph', () => {
  it('gives every unit the syllabus names a module, even when research named none of them', async () => {
    const topic = store.topics.create(intake);
    attachSyllabus(topic);
    boot(outlineOf(['A history of communication', 'Famous compression formats', 'Why bits matter']));

    const graph = await generate(topic);

    expect(readTopicState(dataRoot, topic.id).status).toBe('ready');
    const titles = graph.nodes.map((n) => n.title);
    for (const unit of UNITS) expect(titles).toContain(unit);
  });

  it('inserts the units in the material’s own order', async () => {
    const topic = store.topics.create(intake);
    attachSyllabus(topic);
    boot(outlineOf(['A history of communication']));

    const graph = await generate(topic);

    const ordered = [...graph.nodes].sort((a, b) => a.ordinal - b.ordinal).map((n) => n.title);
    const positions = UNITS.map((unit) => ordered.indexOf(unit));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('keeps a prerequisite the syllabus never mentions but the learner plainly needs', async () => {
    const topic = store.topics.create(intake);
    attachSyllabus(topic);
    // Research puts the background the syllabus assumes first, then its own ideas.
    boot(outlineOf(['Logarithms and their arithmetic', 'A history of communication', 'Why bits matter']));

    const titles = (await generate(topic)).nodes.map((n) => n.title);

    // The syllabus is silent on logarithms; a course on entropy is not.
    expect(titles).toContain('Logarithms and their arithmetic');
    for (const unit of UNITS) expect(titles).toContain(unit);
  });

  it('does not add a second module for a unit the outline already covers in its own words', async () => {
    const topic = store.topics.create(intake);
    attachSyllabus(topic);
    boot(outlineOf(['Entropy of a discrete source', 'Source coding and Huffman codes', 'A history of communication']));

    const titles = (await generate(topic)).nodes.map((n) => n.title);

    expect(titles).toContain('Entropy of a discrete source');
    expect(titles).not.toContain('Entropy');
    expect(titles).toContain('Source coding and Huffman codes');
    expect(titles).not.toContain('Source coding');
    // The units it did NOT cover are still added.
    expect(titles).toContain('Channel capacity');
  });

  it('leaves the no-material path exactly as it was', async () => {
    const topic = store.topics.create(intake);
    const proposed = ['A history of communication', 'Why bits matter', 'Famous compression formats'];
    boot(outlineOf(proposed));

    const titles = (await generate(topic)).nodes.map((n) => n.title);

    // Nothing was brought, so nothing is imposed: the outline's own titles survive and
    // the rest of the count is filled the way it always was.
    for (const title of proposed) expect(titles).toContain(title);
    for (const unit of UNITS) expect(titles).not.toContain(unit);
  });
});
