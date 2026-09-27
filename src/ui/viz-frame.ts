// FRACTAL: implements F3 | component C10
/**
 * The frame an `interactive` lesson block runs in, and the handful of messages that cross
 * its edge.
 *
 * WHY the block's code is posted in rather than put in `srcdoc`: a `srcdoc` (or `blob:`)
 * document inherits the embedding page's Content-Security-Policy, and the page's policy —
 * rightly — runs no inline script but Next's own nonce-stamped bootstrap. The frame is
 * therefore a real URL (`/viz-frame`) served with a policy of its own (`vizFrameCsp`), which
 * asks its parent for the block's HTML once it is listening and writes it into itself.
 *
 * WHY the frame is sandboxed without `allow-same-origin`, and this is the load-bearing line
 * of the whole feature: the block's script runs as written, so the only thing standing
 * between it and the learner's session credential (a `<meta>` in the parent) is that the
 * frame's origin is opaque. See `vizFrameCsp` for the second fence.
 */

export const VIZ_FRAME_PATH = '/viz-frame';

/** What the frame's sandbox allows: script, and nothing that would widen its reach. */
export const VIZ_FRAME_SANDBOX = 'allow-scripts';

export const VIZ_READY = 'la-viz-ready';
export const VIZ_RENDER = 'la-viz-render';
export const VIZ_HEIGHT = 'la-viz-height';

export const MIN_VIZ_HEIGHT = 80;
export const MAX_VIZ_HEIGHT = 1600;
export const DEFAULT_VIZ_HEIGHT = 360;

export type VizMessage = { type: typeof VIZ_READY } | { type: typeof VIZ_HEIGHT; height: number };

/**
 * Read a message from the frame, or null if it is not one of ours. WHY this is strict: the
 * frame runs code nobody reviewed, so anything it posts is untrusted input to the parent —
 * the parent reads two message types and one number, and nothing else.
 */
export function readVizMessage(data: unknown): VizMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record.type === VIZ_READY) return { type: VIZ_READY };
  if (record.type === VIZ_HEIGHT && typeof record.height === 'number' && Number.isFinite(record.height)) {
    return { type: VIZ_HEIGHT, height: record.height };
  }
  return null;
}

/** A reported height held to something that fits in a lesson, whatever the frame claims. */
export function clampVizHeight(height: number): number {
  return Math.min(MAX_VIZ_HEIGHT, Math.max(MIN_VIZ_HEIGHT, Math.ceil(height)));
}

/**
 * Written ahead of the block's own HTML: the app's palette as CSS variables, so a block can
 * belong to the page without guessing its colours, and a reporter that tells the parent how
 * tall the content is, so the frame never shows a scrollbar inside the lesson.
 */
const PRELUDE = `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="dark">
<style>
:root{color-scheme:dark;--text:#e9eef5;--muted:#98a2b3;--line:#232b38;--line-strong:#7a8496;--panel:#171d27;--panel-sunk:#10151d;--accent:#6ee7b7;--accent-2:#a78bfa;--warn:#fbbf24;--danger:#fb7185}
html,body{margin:0;background:transparent;color:var(--text);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
button,input,select,textarea{font:inherit;color:inherit}
button{background:#222a36;border:1px solid var(--line-strong);border-radius:10px;padding:4px 12px;cursor:pointer}
input[type=range]{accent-color:var(--accent-2)}
svg,canvas{max-width:100%}
</style>
<script>(function(){var last=0;function send(){var h=Math.ceil(document.documentElement.scrollHeight);if(h!==last){last=h;parent.postMessage({type:${JSON.stringify(VIZ_HEIGHT)},height:h},"*");}}
if(typeof ResizeObserver==="function")new ResizeObserver(send).observe(document.documentElement);
addEventListener("load",send);setTimeout(send,50);})();</script>
`;

/**
 * The document served at `/viz-frame`. It listens once for the block's HTML from its parent,
 * then replaces itself with prelude + block. WHY `event.source === parent`: the frame should
 * take its code only from the lesson that embedded it.
 */
export function vizFrameDocument(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><title>Lesson visualization</title></head>
<body style="margin:0;background:transparent"><script>
(function(){
  var prelude = ${JSON.stringify(PRELUDE).replace(/</g, '\\u003c')};
  addEventListener("message", function onMessage(event){
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.type !== ${JSON.stringify(VIZ_RENDER)} || typeof data.html !== "string") return;
    removeEventListener("message", onMessage);
    document.open();
    document.write(prelude + data.html);
    document.close();
  });
  parent.postMessage({ type: ${JSON.stringify(VIZ_READY)} }, "*");
})();
</script></body></html>`;
}
