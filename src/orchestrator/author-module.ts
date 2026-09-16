// FRACTAL: implements F2, F12 | component C4
import { z } from 'zod';
import type { ModuleGraph, ModuleNode, Topic, TopicNote } from '@/shapes';
import type { ModuleBrief } from '@/cli/prompt';
import { log } from '@/core/log';
import { nowIso } from '@/orchestrator/ids';
import { tryValidateModuleContent } from '@/orchestrator/content-validate';
import { commitModule } from '@/orchestrator/reconcile';
import { AUTHORING_TOOLS, dispatchSession, type OrchestratorDeps } from '@/orchestrator/session';
import { recordContractOutcome } from '@/orchestrator/contract-rate';
import { MAX_CONTRACT_PATCH_ROUNDS, patchContract } from '@/orchestrator/contract-patch';
import { loadMaterial, moduleView, type TopicMaterial } from '@/source/material';

export const AUTHOR_TIMEOUT_MS = 10 * 60 * 1000;

export const authorOutputSchema = z.object({}).passthrough();

export type AuthorOutcome =
  | { ok: true; node: ModuleNode; coercions: string[] }
  | { ok: false; note: TopicNote; code: string };

function oneLine(node: ModuleNode): { title: string; oneLine: string } {
  return {
    title: node.title,
    oneLine: node.content?.learningGoals[0] ?? 'Not written yet.',
  };
}

export function authoringBrief(
  topic: Topic,
  drivingQuestion: string,
  graph: ModuleGraph,
  node: ModuleNode,
  objectives: string[],
  material: TopicMaterial | null = null,
): ModuleBrief {
  const prereqIds = new Set(graph.edges.filter((e) => e.to === node.id).map((e) => e.from));
  const downstreamIds = new Set(graph.edges.filter((e) => e.from === node.id).map((e) => e.to));
  return {
    // WHY the excerpt is chosen per module and not per topic: what this lesson needs is
    // the passage about ITS idea. Handing every session the same digest of the whole book
    // spends the context on twelve lessons' worth of material to write one.
    ...(material === null
      ? {}
      : { sourceMaterial: moduleView(material, [node.title, ...objectives].join(' ')) }),
    topicSubject: topic.subject,
    level: topic.level,
    levelDetail: topic.levelDetail ?? null,
    purpose: topic.purpose,
    drivingQuestion,
    moduleTitle: node.title,
    moduleObjectives: objectives,
    prerequisiteSummaries: graph.nodes.filter((n) => prereqIds.has(n.id)).map(oneLine),
    downstreamSummaries: graph.nodes.filter((n) => downstreamIds.has(n.id)).map(oneLine),
    priorKnowledge: topic.diagnostic?.priorKnowledge ?? [],
    targetMinutes: node.estimatedMinutes,
  };
}

// WHY: the prompt deliberately does not ask for `authoredAt` or `authoredBySession` —
// a session cannot know its own id, and a self-reported timestamp is not evidence of
// anything. C4 stamps both from what it actually observed, and a value the model
// invented for either field is overwritten rather than trusted.
function stampAuthorship(output: unknown, sessionId: string | null): unknown {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) return output;
  const record = output as Record<string, unknown>;
  return {
    ...record,
    authoredAt: nowIso(),
    authoredBySession: sessionId ?? record.authoredBySession,
  };
}

// WHY: one sandboxed session per module, writing only its own module directory.
// A failure here keeps every other module usable — the partial curriculum is
// never discarded and never presented as complete.
export async function authorModule(
  deps: OrchestratorDeps,
  topic: Topic,
  drivingQuestion: string,
  graph: ModuleGraph,
  node: ModuleNode,
  objectives: string[],
  signal: AbortSignal,
): Promise<AuthorOutcome> {
  const material = loadMaterial(deps.store, deps.dataRoot, topic.id);
  const brief = authoringBrief(topic, drivingQuestion, graph, node, objectives, material);
  const kind = node.kind === 'detour' ? 'detour' : 'author-module';
  const startedAt = Date.now();

  // WHY the patch rounds re-send the whole brief instead of resuming the session that
  // wrote the lesson: resuming is a Claude-CLI feature, and on the stateless transports a
  // resumed turn arrives with no lesson at all — the correction would silently become a
  // session asked to fix an object it cannot see. Re-briefing costs tokens and works
  // everywhere, and the refusal report is carried in the brief itself, so every provider
  // gets the same loop.
  const patched = await patchContract({
    rounds: MAX_CONTRACT_PATCH_ROUNDS,
    attempt: async (issues) => {
      const outcome = await dispatchSession(deps, {
        kind,
        topicId: topic.id,
        workspaceModuleId: node.id,
        brief: issues === null ? brief : { ...brief, contractIssues: issues },
        outputSchema: authorOutputSchema,
        timeoutMs: AUTHOR_TIMEOUT_MS,
        maxTurns: 40,
        allowedTools: AUTHORING_TOOLS,
        signal,
      });
      return outcome.ok ? { ok: true as const, answer: outcome } : { ok: false as const, failure: outcome };
    },
    check: (answer) => {
      const result = tryValidateModuleContent(stampAuthorship(answer.output, answer.sessionId));
      return result.ok
        ? { ok: true as const, value: { content: result.content, coercions: result.coercions } }
        : { ok: false as const, issues: result.issues };
    },
    onRefused: (issues, round) => {
      log({
        level: 'warn',
        event: 'orchestrator-contract-patch',
        component: 'C4',
        topicId: topic.id,
        kind,
        round,
        // WHY these are safe to log verbatim: they are schema key paths and zod issue
        // codes, so neither half can carry a word the model wrote (@/core/contract-issues).
        contractIssues: issues,
        // The last round has nobody left to ask; every earlier one is about to re-ask.
        retrying: round < MAX_CONTRACT_PATCH_ROUNDS,
      });
    },
  });

  if (patched.kind === 'unavailable') {
    const outcome = patched.failure;
    log({ level: 'warn', event: 'orchestrator-author-failed', component: 'C4', topicId: topic.id, code: outcome.code });
    recordContractOutcome(deps.dataRoot, {
      outcome: 'dispatch-failed',
      kind,
      coercions: [],
      durationMs: Date.now() - startedAt,
      patchRounds: patched.rounds,
      code: outcome.code,
    });
    return {
      ok: false,
      code: outcome.code,
      note: {
        kind: 'generation-failure',
        message: `Authoring failed for "${node.title}". ${outcome.message}`,
        affectedModules: [node.id],
        createdAt: nowIso(),
      },
    };
  }

  if (patched.kind === 'refused') {
    recordContractOutcome(deps.dataRoot, {
      outcome: 'invalid-content',
      kind,
      coercions: [],
      durationMs: Date.now() - startedAt,
      patchRounds: patched.rounds,
      code: 'invalid-content',
    });
    return {
      ok: false,
      code: 'invalid-content',
      note: {
        kind: 'generation-failure',
        // WHY the learner-facing wording did not change with the loop: they are told what
        // happened to their lesson, and how many times we asked for it is our business.
        message: `Authoring failed for "${node.title}". The lesson that came back wasn't in a form we could save.`,
        affectedModules: [node.id],
        createdAt: nowIso(),
      },
    };
  }

  const validated = patched.value;
  recordContractOutcome(deps.dataRoot, {
    outcome: validated.coercions.length === 0 ? 'clean' : 'coerced',
    kind,
    coercions: validated.coercions,
    durationMs: Date.now() - startedAt,
    // WHY this is recorded on a SUCCESS: a lesson that took two rounds to land is still a
    // contract the model missed, and counting only the failures would show the loop
    // repairing the evidence that the prompt needs work.
    patchRounds: patched.rounds,
  });

  const committed = commitModule(deps.store, deps.dataRoot, node, validated.content);
  return { ok: true, node: committed, coercions: validated.coercions };
}
