// FRACTAL: implements F1 | component C9
import { topicIdSchema, type GenerationProgress } from '@/shapes';
import { errorResponse, guardStream, sseHeaders, type RouteContext } from '@/api/respond';
import { requireStore } from '@/api/services';
import { parseParam } from '@/api/validate';
import { TOKEN_HEADER } from '@/api/auth';
import { tokenMatches } from '@/api/token';
import { log } from '@/core/log';
import type { SseEvent } from '@/api/shapes';

const HEARTBEAT_MS = 30_000;
const MAX_STREAM_MS = 60 * 60 * 1000;

function frame(event: SseEvent<unknown>): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export async function GET(req: Request, ctx: RouteContext<{ id: string }>): Promise<Response> {
  const denied = guardStream(req);
  if (denied !== null) return denied;

  let stream: ReadableStream<Uint8Array>;
  try {
    const topicId = parseParam(topicIdSchema, (await ctx.params).id, 'subject id');
    const svc = requireStore();
    const presented = req.headers.get(TOKEN_HEADER);
    const encoder = new TextEncoder();
    const iterator = svc.orchestrator.subscribe(topicId)[Symbol.asyncIterator]();

    stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        let open = true;
        // WHY: shutdown() closes over these before they are set, so they live in a
        // holder rather than as bindings that would have to be reassigned.
        const timers: { heartbeat?: NodeJS.Timeout; lifetime?: NodeJS.Timeout } = {};

        const shutdown = (reason: string): void => {
          if (!open) return;
          open = false;
          if (timers.heartbeat !== undefined) clearInterval(timers.heartbeat);
          if (timers.lifetime !== undefined) clearTimeout(timers.lifetime);
          void iterator.return?.();
          try {
            controller.close();
          } catch {
            // the client already closed the socket; nothing left to close
          }
          log({ level: 'info', event: 'sse-closed', component: 'C9', reason });
        };

        const send = (event: SseEvent<unknown>): void => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(frame(event)));
          } catch {
            shutdown('client-gone');
          }
        };

        const emit = (progress: GenerationProgress): void => {
          send({ event: 'progress', data: progress });
          if (progress.phase === 'done') {
            send({ event: 'done', data: progress });
            shutdown('generation-finished');
          }
        };

        emit(svc.orchestrator.progress(topicId));

        // WHY: a comment frame distinguishes "stalled" from "idle" for the reader, and
        // it is also where a rotated per-launch token drops the connection.
        timers.heartbeat = setInterval(() => {
          if (!tokenMatches(presented)) {
            send({ event: 'error', data: { message: 'This page lost its connection to the app. Reload it to continue.' } });
            shutdown('token-rotated');
            return;
          }
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
          } catch {
            shutdown('client-gone');
          }
        }, HEARTBEAT_MS);

        timers.lifetime = setTimeout(() => shutdown('max-lifetime'), MAX_STREAM_MS);

        req.signal.addEventListener('abort', () => shutdown('client-disconnected'));

        const pump = async (): Promise<void> => {
          while (open) {
            const next = await iterator.next();
            if (next.done === true) break;
            emit(next.value);
          }
        };

        void pump()
          .catch((e: unknown) => {
            log({
              level: 'warn',
              event: 'sse-pump-failed',
              component: 'C9',
              detail: e instanceof Error ? e.message : String(e),
            });
            send({ event: 'error', data: { message: 'Progress updates stopped. Reload the page to pick them up again.' } });
          })
          .finally(() => shutdown('stream-ended'));
      },
      cancel(): void {
        void iterator.return?.();
      },
    });
  } catch (e) {
    return errorResponse(e);
  }

  return new Response(stream, { status: 200, headers: sseHeaders() });
}
