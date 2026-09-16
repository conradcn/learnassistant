// FRACTAL: covers F2 | type unit | path what-the-subject-page-does-while-a-run-is-live
/**
 * The subject page used to load once and never again: for the five to ten minutes of a
 * generation it was byte-identical, and a crashed job looked exactly like a running one.
 * These are the things that had to become true — the count moves, the graph is refetched
 * as lessons land, a lost stream falls back to polling instead of freezing, and a run that
 * dies says so instead of going on promising lessons.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Suspense } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type {
  ApiResponse,
  GenerationProgress,
  ModuleGraph,
  ModuleId,
  ModuleNode,
  ProviderView,
  TopicNote,
  TopicStatus,
} from '@/shapes';
import {
  exampleGenerationProgress,
  exampleModuleContent,
  exampleModuleNode,
  exampleTopic,
} from '@/shapes';
import type { TopicDetailView } from '@/ui/shapes';
import { resetAppStore } from '@/ui/store';

type Handlers = {
  onProgress: (p: GenerationProgress) => void;
  onError: (message: string) => void;
  onClose?: () => void;
};

let detail: TopicDetailView;
let getTopicCalls = 0;
let handlers: Handlers | null = null;
let teardowns = 0;

const getTopic = vi.fn((): Promise<ApiResponse<TopicDetailView>> => {
  getTopicCalls += 1;
  return Promise.resolve({ ok: true, data: detail });
});

const provider = { available: true, model: 'claude', kind: 'claude' } as unknown as ProviderView;

vi.mock('@/ui/api-client', () => ({
  getTopic: () => getTopic(),
  getProvider: (): Promise<ApiResponse<ProviderView>> =>
    Promise.resolve({ ok: true, data: provider }),
  startGeneration: vi.fn(),
  requestDetour: vi.fn(),
  deleteTopic: vi.fn(),
  subscribeProgress: (_id: unknown, h: Handlers): (() => void) => {
    handlers = h;
    return (): void => {
      teardowns += 1;
      handlers = null;
    };
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

const TopicPage = (await import('../../app/topics/[id]/page')).default;

function node(ordinal: number, written: boolean): ModuleNode {
  return {
    ...exampleModuleNode,
    id: `m_${String(ordinal).padStart(16, '0')}` as ModuleId,
    topicId: exampleTopic.id,
    ordinal,
    title: `Lesson ${ordinal}`,
    kind: 'module',
    state: 'available',
    content: written ? exampleModuleContent : null,
  };
}

function viewOf(status: TopicStatus, nodes: ModuleNode[], notes: TopicNote[] = []): TopicDetailView {
  const graph: ModuleGraph = {
    topicId: exampleTopic.id,
    nodes,
    edges: [],
    entryModules: nodes.map((n) => n.id),
  };
  return {
    topic: { ...exampleTopic, status, notes, drivingQuestion: null },
    graph,
    availability: nodes.map((n) => ({ moduleId: n.id, state: 'available', unmetPrereqs: [] })),
    extensions: [],
  } as unknown as TopicDetailView;
}

function tick(over: Partial<GenerationProgress> = {}): GenerationProgress {
  return { ...exampleGenerationProgress, topicId: exampleTopic.id, ...over };
}

async function mount(): Promise<void> {
  // `use(params)` suspends on the first render, so the render itself has to be awaited
  // inside act or the boundary never gets past its fallback.
  await act(async () => {
    render(
      <Suspense fallback={<p>loading</p>}>
        <TopicPage params={Promise.resolve({ id: exampleTopic.id })} />
      </Suspense>,
    );
  });
  await screen.findByTestId('topic-status');
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setInterval', 'clearInterval'] });
  getTopicCalls = 0;
  teardowns = 0;
  handlers = null;
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  resetAppStore();
  vi.clearAllMocks();
});

describe('F2: a subject page with a run under way', () => {
  it('counts the lessons as they land and refetches the graph for each one', async () => {
    detail = viewOf('generating', [node(1, true), node(2, false), node(3, false)]);
    await mount();
    expect(screen.getByTestId('topic-writing-more')).toBeTruthy();

    act(() => handlers?.onProgress(tick({ modulesDone: 1, modulesTotal: 3 })));
    await waitFor(() =>
      expect(screen.getByTestId('topic-progress').textContent).toContain('1 of 3'),
    );
    const afterFirst = getTopicCalls;

    detail = viewOf('generating', [node(1, true), node(2, true), node(3, false)]);
    act(() => handlers?.onProgress(tick({ modulesDone: 2, modulesTotal: 3 })));
    await waitFor(() =>
      expect(screen.getByTestId('topic-progress').textContent).toContain('2 of 3'),
    );
    // The tick carries counts; the lesson itself only reaches the page via the refetch.
    expect(getTopicCalls).toBeGreaterThan(afterFirst);
  });

  it('does not announce the climbing count, only the reassurance', async () => {
    detail = viewOf('generating', [node(1, false)]);
    await mount();
    act(() => handlers?.onProgress(tick({ modulesDone: 1, modulesTotal: 4 })));
    await waitFor(() => expect(screen.getByTestId('topic-progress')).toBeTruthy());

    // The regression this guards: role="status" on the whole card meant every lesson
    // written interrupted a screen reader with the same sentence plus a new number.
    const live = screen.getByTestId('topic-writing-more').querySelector('[role="status"]');
    expect(live).not.toBeNull();
    expect(live?.textContent).toContain('appear below as they land');
    expect(live?.contains(screen.getByTestId('topic-progress'))).toBe(false);
  });

  it('keeps the reassurance in the live region while the plan itself is being written', async () => {
    detail = viewOf('generating', []);
    await mount();
    act(() => handlers?.onProgress(tick({ phase: 'research', modulesDone: 0, modulesTotal: 6 })));
    await waitFor(() => expect(screen.getByTestId('topic-progress')).toBeTruthy());

    const live = screen.getByTestId('topic-planning').querySelector('[role="status"]');
    expect(live?.textContent).toContain('Feel free to leave');
    expect(live?.contains(screen.getByTestId('topic-progress'))).toBe(false);
  });

  it('falls back to polling when the stream ends mid-run, and says so', async () => {
    detail = viewOf('generating', [node(1, false)]);
    await mount();
    const before = getTopicCalls;
    act(() => handlers?.onClose?.());
    await waitFor(() => expect(screen.getByTestId('topic-progress-polling')).toBeTruthy());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(getTopicCalls).toBeGreaterThan(before);
  });

  it('unsubscribes on unmount', async () => {
    detail = viewOf('generating', [node(1, false)]);
    await mount();
    cleanup();
    expect(teardowns).toBe(1);
  });
});

describe('F2: a run that stopped', () => {
  const failure: TopicNote = {
    kind: 'generation-failure',
    message: 'Could not research an outline for this subject.',
    affectedModules: [],
    createdAt: exampleGenerationProgress.lastTickAt,
  };

  it('says so, in place of the notice that promised lessons', async () => {
    detail = viewOf('needs-attention', [node(1, false)], [failure]);
    await mount();
    expect(screen.getByTestId('topic-generation-failed')).toBeTruthy();
    expect(screen.queryByTestId('topic-planning')).toBeNull();
    expect(screen.queryByTestId('topic-writing-more')).toBeNull();
    expect(screen.queryByTestId('topic-progress')).toBeNull();
  });

  it('does not call an ordinary hand-back a failure', async () => {
    // Research lands the outline and hands the subject back on `needs-attention` with no
    // failure note. That is the button's turn, not a crash.
    detail = viewOf('needs-attention', [node(1, false)]);
    await mount();
    expect(screen.queryByTestId('topic-generation-failed')).toBeNull();
    expect(screen.getByTestId('write-lessons-card')).toBeTruthy();
  });
});
