// FRACTAL: covers F2 | type integration lifecycle
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { resetConfigCache, saveConfig } from '@/core/config';
import { exampleSessionId, moduleIdSchema, topicIdSchema } from '@/shapes';
import type { CliSessionResult, CliSessionSpec } from '@/shapes';
import type { ModuleBrief } from '@/cli/prompt';

const TOPIC = topicIdSchema.parse('t_9fQ2xK4mZa71bC0d');
const MODULE = moduleIdSchema.parse('m_71bC0d9fQ2xK4mZa');

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), 'la-conv-cell-'));
  process.env.LA_DATA_ROOT = dataRoot;
  process.env.LA_PROVIDER = 'claude';
  resetConfigCache();
  saveConfig({ dataRoot, claudeBin: 'claude', provider: 'claude' });
  delete (globalThis as unknown as Record<symbol, unknown>)[
    Symbol.for('learn-assistant.orchestrator.conversations')
  ];
});

const brief: ModuleBrief = {
  topicSubject: 'Information theory',
  level: 'intermediate',
  levelDetail: null,
  purpose: 'Understand entropy.',
  drivingQuestion: 'What does entropy measure?',
  moduleTitle: 'Entropy',
  moduleObjectives: ['Define entropy'],
  prerequisiteSummaries: [],
  downstreamSummaries: [],
  priorKnowledge: [],
  targetMinutes: 20,
};

/** Records the conversation argv each dispatch handed the CLI. */
function fakeRunner(seen: (CliSessionSpec['conversation'] | undefined)[]): {
  run: (spec: CliSessionSpec) => Promise<CliSessionResult>;
  cancel: (id: unknown) => void;
} {
  return {
    run: async (spec) => {
      seen.push(spec.conversation);
      return { ok: true, id: exampleSessionId, output: { done: true }, durationMs: 1, filesWritten: [] };
    },
    cancel: () => undefined,
  };
}

async function loadFreshModule(): Promise<typeof import('@/orchestrator/session')> {
  vi.resetModules();
  return await import('@/orchestrator/session');
}

describe('F2: the live-conversation map is process-scoped, not module-scoped', () => {
  it('a second, separately loaded copy of the module resumes the uuid the first one stored', async () => {
    const seen: (CliSessionSpec['conversation'] | undefined)[] = [];
    const deps = { store: null as never, runner: fakeRunner(seen) as never, dataRoot };
    const req = {
      kind: 'evaluate' as const,
      topicId: TOPIC,
      workspaceModuleId: MODULE,
      brief,
      conversation: { key: 'capstone:t_9fQ2xK4mZa71bC0d', turnPrompt: 'Here is my answer.' },
      outputSchema: z.object({ done: z.boolean() }),
      timeoutMs: 5_000,
      maxTurns: 4,
      allowedTools: ['Read'],
      signal: new AbortController().signal,
    };

    // The capstone submission lands in one loaded copy of the module...
    const first = await loadFreshModule();
    expect((await first.dispatchSession(deps, req)).ok).toBe(true);

    // ...and its follow-up in another, as separate route bundles do.
    const second = await loadFreshModule();
    expect(second).not.toBe(first);
    expect((await second.dispatchSession(deps, req)).ok).toBe(true);

    expect(seen).toHaveLength(2);
    const opened = seen[0];
    const resumed = seen[1];
    expect(opened).toEqual({ uuid: expect.any(String), resume: false });
    expect(resumed).toEqual({ uuid: opened?.uuid, resume: true });
  });
});
