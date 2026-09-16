// FRACTAL: implements F1, F3, F4, F5, F7, F8, F9, F10, F11, F12, F13, F14 | component C10
import { z } from 'zod';
import {
  calibrationViewSchema,
  cardDeckSchema,
  cardIdSchema,
  cardPackImportSchema,
  cardViewSchema,
  deckIdSchema,
  deckSummarySchema,
  type CardDeck,
  type CardGrade,
  type CardId,
  type CardPackImport,
  type CardView,
  type DeckId,
  type DeckSummary,
  type NewCard,
  dashboardViewSchema,
  diagnosticTurnResultSchema,
  type DiagnosticTurnResult,
  entryDecisionSchema,
  evalSessionSchema,
  evalTurnResultSchema,
  generationProgressSchema,
  healthViewSchema,
  providerViewSchema,
  queueViewSchema,
  providerTestResultSchema,
  type ProviderTestResult,
  type ProviderView,
  type ProviderUpdate,
  recoveryInfoSchema,
  type RecoveryInfo,
  jobSchema,
  lessonQuestionSchema,
  moduleIdSchema,
  moduleNodeSchema,
  practiceSessionSchema,
  predictionSchema,
  warmUpRecordSchema,
  reflectionSchema,
  reviewCueSchema,
  sessionIdSchema,
  stagedSourceSchema,
  topicIdSchema,
  topicSchema,
  type ApiErr,
  type ApiResponse,
  type AppErrorShape,
  type DashboardView,
  type EvalSession,
  type EvalTarget,
  type EvalTurnResult,
  type GenerationProgress,
  type HealthView,
  type Job,
  type LessonQuestion,
  type ModuleId,
  type PracticeSession,
  type Prediction,
  type Reflection,
  type ReviewCue,
  type SelfAssessment,
  type SessionId,
  type StagedSource,
  type Topic,
  type TopicId,
  type TopicIntakeRequest,
  TOKEN_HEADER,
  type QueueView,
} from '@/shapes';
import { topicDetailViewSchema, type TopicDetailView } from '@/ui/shapes';

export const TOKEN_META_NAME = 'la-token';
export const REQUEST_TIMEOUT_MS = 20_000;
// WHY a second budget: most routes only touch local state and 20s is a generous cap for
// them. A handful wait on a whole model turn inside the request, and with a local model
// (Ollama) that turn can run for minutes — under the shared 20s cap the page gave up
// while the server was still working, and the learner saw "that took too long" for a
// reply that then arrived to nobody. The server keeps its own timeout; this one only has
// to outlast it.
export const MODEL_REQUEST_TIMEOUT_MS = 20 * 60 * 1000;
// A third budget, between the two: reading a 25 MB PDF is real local work and can outrun
// the 20s cap, but it is bounded by the file rather than by a model, so it does not need
// the twenty minutes a session turn does.
export const UPLOAD_TIMEOUT_MS = 3 * 60 * 1000;

const reflectionIdSchema = z.string().regex(/^r_[0-9a-f]{16}$/);

const deletedSchema = z.object({ deleted: z.literal(true) }).strict();
const restoredSchema = z.object({ restored: z.boolean() }).strict();
const moduleDetailViewSchema = z.object({
  module: moduleNodeSchema,
  entry: entryDecisionSchema,
  prediction: predictionSchema.nullable(),
  warmUp: warmUpRecordSchema.nullable(),
  questions: z.array(lessonQuestionSchema),
  calibration: calibrationViewSchema.nullable(),
  contentIssue: z.enum(['never-written', 'damaged']).nullable(),
  cardPackDeck: cardDeckSchema.nullable(),
});

export type Deleted = z.infer<typeof deletedSchema>;
export type Restored = z.infer<typeof restoredSchema>;
export type ModuleDetailView = z.infer<typeof moduleDetailViewSchema>;

const OFFLINE_MESSAGE = 'We could not reach the app. Check that it is still running, then try again.';
const UNREADABLE_MESSAGE = 'The app sent back something we could not read. Try again.';
const TIMEOUT_MESSAGE = 'That took too long. Try again.';
const NO_TOKEN_MESSAGE = 'This page lost its connection to the app. Reload it to continue.';
const BAD_LINK_MESSAGE = 'That link is not valid.';

function localError(message: string): ApiErr {
  return { ok: false, error: { code: 'internal', message, correlationId: 'c_browser' } };
}

let liveToken: string | null = null;

/**
 * WHY (H12): the per-launch credential is handed to the page in the served document
 * and read back from it here. It is never written to storage and never logged.
 *
 * WHY (cached): React hoists and re-parents the `<meta>` that carries the token, so
 * after a client-side navigation the node is briefly — sometimes permanently — absent
 * from the document. The credential is constant for the life of the page, so the first
 * successful read is kept in memory and every later call is served from there. Without
 * this, every in-app link had to be a full page load to survive, which is a navigation
 * cost paid to work around a DOM lifetime the framework owns.
 */
export function readSessionToken(
  doc: Document | null = typeof document === 'undefined' ? null : document,
  useCache = true,
): string | null {
  if (useCache && liveToken !== null) return liveToken;
  if (doc === null) return null;
  const meta = doc.querySelector('meta[name="' + TOKEN_META_NAME + '"]');
  if (meta === null) return null;
  const value = meta.getAttribute('content');
  if (value === null || !/^[0-9a-f]{64}$/.test(value)) return null;
  if (useCache) liveToken = value;
  return value;
}

/** Test seam: drops the in-memory copy so a fresh document is read again. */
export function resetSessionTokenCache(): void {
  liveToken = null;
}

/** Every id reaching a URL is matched against its registry schema first — no concatenated raw input. */
function idSegment(schema: z.ZodType<string, z.ZodTypeDef, string>, value: string): string | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return null;
  return encodeURIComponent(parsed.data);
}

const apiErrBodySchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }),
});

function toShape(raw: { code: string; message: string; correlationId: string }): AppErrorShape {
  return { code: raw.code as AppErrorShape['code'], message: raw.message, correlationId: raw.correlationId };
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

async function call<S extends z.ZodTypeAny>(
  schema: S,
  method: Method,
  path: string,
  body?: unknown,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<ApiResponse<z.infer<S>>> {
  const token = readSessionToken();
  if (token === null) return localError(NO_TOKEN_MESSAGE);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text: string;
  try {
    const response = await fetch(path, {
      method,
      signal: controller.signal,
      headers:
        body === undefined
          ? { [TOKEN_HEADER]: token }
          : { [TOKEN_HEADER]: token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    text = await response.text();
  } catch {
    return localError(controller.signal.aborted ? TIMEOUT_MESSAGE : OFFLINE_MESSAGE);
  } finally {
    clearTimeout(timer);
  }

  return interpret(schema, text);
}

/** The half of `call` that turns a body into an answer, shared with the upload path. */
function interpret<S extends z.ZodTypeAny>(schema: S, text: string): ApiResponse<z.infer<S>> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return localError(UNREADABLE_MESSAGE);
  }

  const failure = apiErrBodySchema.safeParse(raw);
  if (failure.success) return { ok: false, error: toShape(failure.data.error) };

  const success = z.object({ ok: z.literal(true), data: schema }).safeParse(raw);
  if (!success.success) return localError(UNREADABLE_MESSAGE);
  return { ok: true, data: success.data.data as z.infer<S> };
}

/**
 * WHY this does not go through `call`: a multipart body must NOT carry a Content-Type
 * header we wrote, because the boundary is generated with the body and only `fetch` knows
 * it. Setting `Content-Type: multipart/form-data` by hand produces a body the server
 * cannot split, which is a silently empty upload rather than an error.
 */
async function callForm<S extends z.ZodTypeAny>(
  schema: S,
  path: string,
  form: FormData,
  timeoutMs: number = UPLOAD_TIMEOUT_MS,
): Promise<ApiResponse<z.infer<S>>> {
  const token = readSessionToken();
  if (token === null) return localError(NO_TOKEN_MESSAGE);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text: string;
  try {
    const response = await fetch(path, {
      method: 'POST',
      signal: controller.signal,
      headers: { [TOKEN_HEADER]: token },
      body: form,
    });
    text = await response.text();
  } catch {
    return localError(controller.signal.aborted ? TIMEOUT_MESSAGE : OFFLINE_MESSAGE);
  } finally {
    clearTimeout(timer);
  }
  return interpret(schema, text);
}

export function getHealth(): Promise<ApiResponse<HealthView>> {
  return call(healthViewSchema, 'GET', '/api/health');
}

export function getDashboard(): Promise<ApiResponse<DashboardView>> {
  return call(dashboardViewSchema, 'GET', '/api/topics');
}

export function createTopic(intake: TopicIntakeRequest): Promise<ApiResponse<Topic>> {
  return call(topicSchema, 'POST', '/api/topics', intake);
}

// WHY the model budget: each step waits on a whole model turn, as a chat turn does.
export function diagnosticTurn(
  topicId: TopicId,
  request: { answer?: string | null; skip?: boolean },
): Promise<ApiResponse<DiagnosticTurnResult>> {
  const id = idSegment(topicIdSchema, topicId);
  if (id === null) return Promise.resolve(localError(BAD_LINK_MESSAGE));
  return call(diagnosticTurnResultSchema, 'POST', `/api/topics/${id}/diagnostic`, request, MODEL_REQUEST_TIMEOUT_MS);
}

/**
 * Hands one file to the app to read. Extraction is local, so this is quick and costs
 * nothing — but a big PDF is still real work, and it gets the longer budget rather than
 * the 20s one every other local call is held to.
 */
export function uploadSourceFile(file: File): Promise<ApiResponse<StagedSource>> {
  const form = new FormData();
  form.append('file', file);
  return callForm(stagedSourceSchema, '/api/source', form);
}

export function stagePastedSource(text: string): Promise<ApiResponse<StagedSource>> {
  return call(stagedSourceSchema, 'POST', '/api/source', { text });
}

export function getTopic(topicId: TopicId): Promise<ApiResponse<TopicDetailView>> {
  const id = idSegment(topicIdSchema, topicId);
  if (id === null) return Promise.resolve(localError(BAD_LINK_MESSAGE));
  return call(topicDetailViewSchema, 'GET', `/api/topics/${id}`);
}

export function deleteTopic(topicId: TopicId): Promise<ApiResponse<Deleted>> {
  const id = idSegment(topicIdSchema, topicId);
  if (id === null) return Promise.resolve(localError(BAD_LINK_MESSAGE));
  return call(deletedSchema, 'DELETE', `/api/topics/${id}`);
}

export function startGeneration(topicId: TopicId): Promise<ApiResponse<Job>> {
  const id = idSegment(topicIdSchema, topicId);
  if (id === null) return Promise.resolve(localError(BAD_LINK_MESSAGE));
  return call(jobSchema, 'POST', `/api/topics/${id}/generate`, {});
}

export function requestDetour(
  topicId: TopicId,
  anchorModuleId: ModuleId,
  question: string,
): Promise<ApiResponse<Job>> {
  const id = idSegment(topicIdSchema, topicId);
  const anchor = idSegment(moduleIdSchema, anchorModuleId);
  if (id === null || anchor === null) return Promise.resolve(localError(BAD_LINK_MESSAGE));
  return call(jobSchema, 'POST', `/api/topics/${id}/detour`, { topicId, anchorModuleId, question });
}

/**
 * WHY the goal is sent and no size is: what the extension costs is worked out from the goal
 * by C4, and a browser that computed it too would be a second answer to keep in step with
 * the one the engine acts on.
 */
export function requestExtension(topicId: TopicId, goal: string): Promise<ApiResponse<Job>> {
  const id = idSegment(topicIdSchema, topicId);
  if (id === null) return Promise.resolve(localError(BAD_LINK_MESSAGE));
  return call(jobSchema, 'POST', `/api/topics/${id}/extend`, { topicId, goal });
}

export function retryModule(topicId: TopicId, moduleId: ModuleId): Promise<ApiResponse<Job>> {
  const id = idSegment(topicIdSchema, topicId);
  const moduleSegment = idSegment(moduleIdSchema, moduleId);
  if (id === null || moduleSegment === null) return Promise.resolve(localError(BAD_LINK_MESSAGE));
  return call(jobSchema, 'POST', `/api/topics/${id}/retry-module`, { moduleId });
}

export function getModule(moduleId: ModuleId): Promise<ApiResponse<ModuleDetailView>> {
  const id = idSegment(moduleIdSchema, moduleId);
  if (id === null) return Promise.resolve(localError(BAD_LINK_MESSAGE));
  return call(moduleDetailViewSchema, 'GET', `/api/modules/${id}`);
}

// WHY the model budget: this waits on a whole model turn inside the request, exactly as a
// chat turn does, and a local model can take minutes over it.
export function askLessonQuestion(
  moduleId: ModuleId,
  question: string,
): Promise<ApiResponse<LessonQuestion>> {
  const id = idSegment(moduleIdSchema, moduleId);
  if (id === null) return Promise.resolve(localError(BAD_LINK_MESSAGE));
  return call(
    lessonQuestionSchema,
    'POST',
    `/api/modules/${id}/ask`,
    { question },
    MODEL_REQUEST_TIMEOUT_MS,
  );
}

export function openEvaluation(target: EvalTarget): Promise<ApiResponse<EvalSession>> {
  return call(evalSessionSchema, 'POST', '/api/eval/open', target, MODEL_REQUEST_TIMEOUT_MS);
}

// WHY (F4): loading the page must not cost a decision, and must not start a second
// conversation. Resuming asks for the transcript that already exists and gets null when
// there is none — only then does the page open one.
export function resumeEvaluation(target: EvalTarget): Promise<ApiResponse<EvalSession | null>> {
  return call(z.object({ session: evalSessionSchema.nullable() }), 'POST', '/api/eval/resume', target).then(
    (response) => (response.ok ? { ok: true as const, data: response.data.session } : response),
  );
}

// WHY: the one deliberate way to throw a conversation away and ask the opening question
// again. Nothing else clears a transcript.
export function restartEvaluation(sessionId: SessionId): Promise<ApiResponse<EvalSession>> {
  const id = idSegment(sessionIdSchema, sessionId);
  if (id === null) return Promise.resolve(localError('That conversation link is not valid.'));
  return call(evalSessionSchema, 'POST', `/api/eval/${id}/restart`, {});
}

// WHY (F4): the counterpart to `sendEvaluationMessage` for a message that was already
// saved. A turn interrupted after the learner's text was written leaves the conversation
// owing a reply with nothing running; opening it again asks for that reply here. `null`
// comes back when the transcript was not waiting on one.
export function continueEvaluation(sessionId: SessionId): Promise<ApiResponse<EvalTurnResult | null>> {
  const id = idSegment(sessionIdSchema, sessionId);
  if (id === null) return Promise.resolve(localError('That conversation link is not valid.'));
  return call(
    evalTurnResultSchema.nullable(),
    'POST',
    `/api/eval/${id}/continue`,
    {},
    MODEL_REQUEST_TIMEOUT_MS,
  );
}

export function sendEvaluationMessage(
  sessionId: SessionId,
  text: string,
  selfAssessment: SelfAssessment | null,
): Promise<ApiResponse<EvalTurnResult>> {
  const id = idSegment(sessionIdSchema, sessionId);
  if (id === null) return Promise.resolve(localError('That conversation link is not valid.'));
  return call(
    evalTurnResultSchema,
    'POST',
    `/api/eval/${id}/send`,
    { text, selfAssessment },
    MODEL_REQUEST_TIMEOUT_MS,
  );
}

export function startPractice(size: number): Promise<ApiResponse<PracticeSession>> {
  return call(practiceSessionSchema, 'POST', '/api/practice/start', { size });
}

export function answerPractice(
  sessionId: SessionId,
  index: number,
  correct: boolean,
): Promise<ApiResponse<PracticeSession>> {
  const id = idSegment(sessionIdSchema, sessionId);
  if (id === null) return Promise.resolve(localError('That practice link is not valid.'));
  return call(practiceSessionSchema, 'POST', `/api/practice/${id}/answer`, { index, correct });
}

export function getReviewsDue(): Promise<ApiResponse<ReviewCue[]>> {
  return call(z.array(reviewCueSchema), 'GET', '/api/reviews/due');
}

export function recordReview(moduleId: ModuleId, correct: boolean): Promise<ApiResponse<ReviewCue>> {
  const id = idSegment(moduleIdSchema, moduleId);
  if (id === null) return Promise.resolve(localError('That lesson link is not valid.'));
  return call(reviewCueSchema, 'POST', `/api/reviews/${id}/record`, { correct });
}

export function recordPrediction(prediction: Prediction): Promise<ApiResponse<Prediction>> {
  return call(predictionSchema, 'POST', '/api/predictions', prediction);
}

export function saveReflection(input: {
  topicId: TopicId;
  moduleId: ModuleId | null;
  text: string;
}): Promise<ApiResponse<Reflection>> {
  return call(reflectionSchema, 'POST', '/api/reflections', input);
}

export function editReflection(reflectionId: string, text: string): Promise<ApiResponse<Reflection>> {
  const id = idSegment(reflectionIdSchema, reflectionId);
  if (id === null) return Promise.resolve(localError('That note link is not valid.'));
  return call(reflectionSchema, 'PATCH', `/api/reflections/${id}`, { text });
}

const deckDetailSchema = z.object({ deck: cardDeckSchema, cards: z.array(cardViewSchema) }).strict();
const cardsAddedSchema = z.object({ cards: z.array(cardViewSchema), skipped: z.array(z.string()) }).strict();

export type DeckDetail = z.infer<typeof deckDetailSchema>;
export type CardsAdded = z.infer<typeof cardsAddedSchema>;

export function listDecks(): Promise<ApiResponse<DeckSummary[]>> {
  return call(z.array(deckSummarySchema), 'GET', '/api/cards/decks');
}

export function createDeck(name: string, topicId: TopicId | null): Promise<ApiResponse<CardDeck>> {
  return call(cardDeckSchema, 'POST', '/api/cards/decks', { name, topicId });
}

export function getDeck(deckId: DeckId): Promise<ApiResponse<DeckDetail>> {
  const id = idSegment(deckIdSchema, deckId);
  if (id === null) return Promise.resolve(localError('That deck link is not valid.'));
  return call(deckDetailSchema, 'GET', `/api/cards/decks/${id}`);
}

export function renameDeck(deckId: DeckId, name: string): Promise<ApiResponse<CardDeck>> {
  const id = idSegment(deckIdSchema, deckId);
  if (id === null) return Promise.resolve(localError('That deck link is not valid.'));
  return call(cardDeckSchema, 'PATCH', `/api/cards/decks/${id}`, { name });
}

export function deleteDeck(deckId: DeckId): Promise<ApiResponse<Deleted>> {
  const id = idSegment(deckIdSchema, deckId);
  if (id === null) return Promise.resolve(localError('That deck link is not valid.'));
  return call(deletedSchema, 'DELETE', `/api/cards/decks/${id}`);
}

export function addCard(deckId: DeckId, card: NewCard): Promise<ApiResponse<CardsAdded>> {
  const id = idSegment(deckIdSchema, deckId);
  if (id === null) return Promise.resolve(localError('That deck link is not valid.'));
  return call(cardsAddedSchema, 'POST', `/api/cards/decks/${id}/cards`, { card });
}

/**
 * Takes the pack of cards this lesson wrote and puts it on the learner's shelf. The cards
 * are not sent — the server reads them from the lesson (see the route's note).
 */
export function addLessonCards(moduleId: ModuleId): Promise<ApiResponse<CardPackImport>> {
  const id = idSegment(moduleIdSchema, moduleId);
  if (id === null) return Promise.resolve(localError(BAD_LINK_MESSAGE));
  return call(cardPackImportSchema, 'POST', `/api/modules/${id}/cards`, {});
}

/** A pasted list of "term — meaning" lines, read into cards by the server. */
export function importCards(deckId: DeckId, paste: string): Promise<ApiResponse<CardsAdded>> {
  const id = idSegment(deckIdSchema, deckId);
  if (id === null) return Promise.resolve(localError('That deck link is not valid.'));
  return call(cardsAddedSchema, 'POST', `/api/cards/decks/${id}/cards`, { paste });
}

export function editCard(cardId: CardId, card: NewCard): Promise<ApiResponse<CardView>> {
  const id = idSegment(cardIdSchema, cardId);
  if (id === null) return Promise.resolve(localError('That card link is not valid.'));
  return call(cardViewSchema, 'PATCH', `/api/cards/${id}`, card);
}

export function deleteCard(cardId: CardId): Promise<ApiResponse<Deleted>> {
  const id = idSegment(cardIdSchema, cardId);
  if (id === null) return Promise.resolve(localError('That card link is not valid.'));
  return call(deletedSchema, 'DELETE', `/api/cards/${id}`);
}

export function getStudyQueue(deckId: DeckId | null): Promise<ApiResponse<CardView[]>> {
  if (deckId === null) return call(z.array(cardViewSchema), 'GET', '/api/cards/study');
  const id = idSegment(deckIdSchema, deckId);
  if (id === null) return Promise.resolve(localError('That deck link is not valid.'));
  return call(z.array(cardViewSchema), 'GET', `/api/cards/study?deckId=${id}`);
}

export function gradeCard(cardId: CardId, grade: CardGrade): Promise<ApiResponse<CardView>> {
  const id = idSegment(cardIdSchema, cardId);
  if (id === null) return Promise.resolve(localError('That card link is not valid.'));
  return call(cardViewSchema, 'POST', `/api/cards/${id}/grade`, { grade });
}

export function submitCapstone(topicId: TopicId, artifact: string): Promise<ApiResponse<EvalTurnResult>> {
  const id = idSegment(topicIdSchema, topicId);
  if (id === null) return Promise.resolve(localError(BAD_LINK_MESSAGE));
  return call(
    evalTurnResultSchema,
    'POST',
    `/api/capstone/${id}/submit`,
    { artifact },
    MODEL_REQUEST_TIMEOUT_MS,
  );
}

// WHY the long budget: with llama.cpp selected this probe starts the server, and the
// answer only comes back once a multi-gigabyte model is resident.
export function getProvider(): Promise<ApiResponse<ProviderView>> {
  return call(providerViewSchema, 'GET', '/api/provider', undefined, MODEL_REQUEST_TIMEOUT_MS);
}

export function setProvider(update: ProviderUpdate): Promise<ApiResponse<ProviderView>> {
  return call(providerViewSchema, 'POST', '/api/provider', update, MODEL_REQUEST_TIMEOUT_MS);
}

// WHY the same long budget as a lesson: this spends one real generation on whichever
// provider is configured, and on a model running on this computer the first answer comes
// only after several gigabytes have loaded.
export function testProviderConnection(): Promise<ApiResponse<ProviderTestResult>> {
  return call(providerTestResultSchema, 'POST', '/api/provider/test', {}, MODEL_REQUEST_TIMEOUT_MS);
}

// WHY the ordinary timeout and not the long one the provider probe uses: this reads rows
// the app already has. If it is slow, that is the answer the screen should show.
export function getQueue(): Promise<ApiResponse<QueueView>> {
  return call(queueViewSchema, 'GET', '/api/queue');
}

export function getRecoveryInfo(): Promise<ApiResponse<RecoveryInfo>> {
  return call(recoveryInfoSchema, 'GET', '/api/recovery');
}

export function restorePreviousCopy(): Promise<ApiResponse<Restored>> {
  return call(restoredSchema, 'POST', '/api/recovery');
}

export type ProgressHandlers = {
  onProgress: (progress: GenerationProgress) => void;
  onError: (message: string) => void;
  /**
   * WHY (F2): the stream ends for reasons that are not errors — the run finished, the
   * server hit its one-hour lifetime cap, a proxy cut an idle socket. None of those call
   * `onError`, so a caller that only listens for failures sits on a page that has quietly
   * stopped updating and cannot tell. This fires exactly once, on every ending, so the
   * caller can fall back to polling instead of freezing.
   */
  onClose?: () => void;
};

function parseSseBlock(block: string): { event: string; data: string } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

/**
 * WHY: `EventSource` cannot carry the per-launch token header, so the stream is read off a
 * plain fetch. The returned function is the caller's teardown and must run on unmount.
 */
export function subscribeProgress(topicId: TopicId, handlers: ProgressHandlers): () => void {
  const id = idSegment(topicIdSchema, topicId);
  const token = readSessionToken();
  if (id === null || token === null) {
    handlers.onError(id === null ? BAD_LINK_MESSAGE : NO_TOKEN_MESSAGE);
    return (): void => undefined;
  }
  const controller = new AbortController();
  void (async (): Promise<void> => {
    try {
      const response = await fetch(`/api/topics/${id}/stream`, {
        headers: { [TOKEN_HEADER]: token },
        signal: controller.signal,
      });
      const body = response.body;
      if (body === null) {
        handlers.onError('Progress updates are unavailable right now. Reload the page to pick them up again.');
        return;
      }
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done === true) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let split = buffer.indexOf('\n\n');
        while (split !== -1) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const parsed = parseSseBlock(block);
          if (parsed !== null) {
            if (parsed.event === 'progress' || parsed.event === 'done') {
              let raw: unknown = null;
              try {
                raw = JSON.parse(parsed.data);
              } catch {
                raw = null;
              }
              const progress = generationProgressSchema.safeParse(raw);
              if (progress.success) handlers.onProgress(progress.data);
            } else if (parsed.event === 'error') {
              handlers.onError('Progress updates stopped. Reload the page to pick them up again.');
            }
          }
          split = buffer.indexOf('\n\n');
        }
      }
    } catch {
      if (!controller.signal.aborted) {
        handlers.onError('Progress updates stopped. Reload the page to pick them up again.');
      }
    } finally {
      // Teardown is the caller's own doing, so it is the one ending that is not news.
      if (!controller.signal.aborted) handlers.onClose?.();
    }
  })();
  return (): void => controller.abort();
}
