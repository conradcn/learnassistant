// FRACTAL: implements F4, F9, F13 | component C6
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  exampleEvalScript,
  exampleModuleContent,
  type EvalScript,
  type ModuleNode,
  type PrereqEdge,
  type Topic,
} from '@/shapes';
import { assertNotInRelease } from '@/core/release';
import { resetConfigCache, saveConfig } from '@/core/config';
import { closeStore, openStore, type Store } from '@/store/open';
import type { NewTopic } from '@/store/topics';
import { SessionRunner } from '@/cli/run-session';
import { KindTransport } from '@/orchestrator/transport.kind';
import { createOrchestrator, type Orchestrator } from '@/orchestrator/engine';
import { newModuleId } from '@/orchestrator/ids';
import { createEvalEngine, type EvalEngine } from '@/eval/session';

assertNotInRelease('eval/harness.testing');

export type EvaluatorReply = {
  reply: string;
  mode?: 'question' | 'hint' | 'explanation' | 'teach-back' | 'verdict';
  angle?: string | null;
  outcome?: 'pass' | 'assisted-pass' | 'fail' | 'continue';
  assistLevel?: 0 | 1 | 2 | 3;
  misunderstanding?: string | null;
  nextAngle?: string | null;
  remedialNeeded?: boolean;
  rationale?: string;
};

export const SUPPORTED_RATIONALE =
  'Explains entropy as an expectation over the distribution, and treats the per symbol constant case as a check.';

export function evaluatorOutput(r: EvaluatorReply): unknown {
  return {
    reply: r.reply,
    mode: r.mode ?? 'question',
    angle: r.angle ?? null,
    verdict: {
      outcome: r.outcome ?? 'continue',
      assistLevel: r.assistLevel ?? 0,
      misunderstanding: r.misunderstanding ?? null,
      nextAngle: r.nextAngle ?? null,
      remedialNeeded: r.remedialNeeded ?? false,
      rationale: r.rationale ?? SUPPORTED_RATIONALE,
    },
  };
}

export type Harness = {
  dataRoot: string;
  store: Store;
  runner: SessionRunner;
  orchestrator: Orchestrator;
  engine: EvalEngine;
  prompts: string[];
  /** The argv of every spawn, in order — how a test sees which CLI conversation was used. */
  spawns: { kind: string; argv: string[] }[];
  respondWith(fn: (prompt: string) => unknown): void;
  reopenStore(): Store;
  teardown(): Promise<void>;
};

export const intake: NewTopic = {
  subject: 'Information theory',
  level: 'intermediate',
  purpose: 'build a compressor with an agent',
  diagnostic: null,
};

export function bootHarness(): Harness {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-eval-'));
  process.env.LA_DATA_ROOT = dataRoot;
  resetConfigCache();
  saveConfig({ dataRoot, claudeBin: 'claude', sessionConcurrency: 3 });

  let responder: (prompt: string) => unknown = () => evaluatorOutput({ reply: 'Tell me more about that.' });
  const prompts: string[] = [];
  const transport = new KindTransport({
    responder: (_kind, prompt) => {
      prompts.push(prompt);
      return responder(prompt);
    },
  });
  const runner = new SessionRunner({ transport });

  const store = openStore(dataRoot);
  const orchestrator = createOrchestrator({ store, runner, dataRoot });
  const engine = createEvalEngine({ store, runner, dataRoot, orchestrator });

  const harness: Harness = {
    dataRoot,
    store,
    runner,
    orchestrator,
    engine,
    prompts,
    spawns: transport.spawns,
    respondWith(fn): void {
      responder = fn;
    },
    reopenStore(): Store {
      closeStore(dataRoot);
      return openStore(dataRoot);
    },
    async teardown(): Promise<void> {
      await engine.close();
      await orchestrator.close();
      await runner.close();
      closeStore(dataRoot);
      delete process.env.LA_DATA_ROOT;
      resetConfigCache();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
  return harness;
}

export type SeedOptions = {
  script?: EvalScript;
  titles?: string[];
  withCapstone?: boolean;
  subject?: string;
  purpose?: string;
  capstoneSpec?: string;
};

export function seedTopic(store: Store, opts?: SeedOptions): { topic: Topic; nodes: ModuleNode[] } {
  const script = opts?.script ?? exampleEvalScript;
  const topic = store.topics.create({
    ...intake,
    subject: opts?.subject ?? intake.subject,
    purpose: opts?.purpose ?? intake.purpose,
  });
  const titles = opts?.titles ?? ['Entropy as expected surprise', 'Codes and lengths'];
  const nodes: ModuleNode[] = titles.map((title, i) => ({
    id: newModuleId(),
    topicId: topic.id,
    title,
    ordinal: i + 1,
    kind: 'module',
    testOutEligible: true,
    estimatedMinutes: 20,
    state: i === 0 ? 'available' : 'not-yet-recommended',
    content: { ...exampleModuleContent, evalScript: script },
  }));
  const edges: PrereqEdge[] = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id }));
  if (opts?.withCapstone === true) {
    const capstone: ModuleNode = {
      id: newModuleId(),
      topicId: topic.id,
      title: 'Build a working compressor',
      ordinal: titles.length + 1,
      kind: 'capstone',
      testOutEligible: false,
      estimatedMinutes: 120,
      state: 'available',
      content: {
        ...exampleModuleContent,
        explanation: {
          kind: 'text',
          markdown: opts.capstoneSpec ?? 'Build a Huffman coder and justify every design choice.',
        },
        evalScript: script,
      },
    };
    for (const n of nodes) edges.push({ from: n.id, to: capstone.id });
    nodes.push(capstone);
  }
  store.modules.upsertGraph({ topicId: topic.id, nodes, edges, entryModules: [nodes[0].id] });
  return { topic, nodes };
}
