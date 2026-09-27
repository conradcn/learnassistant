// FRACTAL: implements F3 | component C10
'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { InteractiveBlock } from '@/shapes';
import { MathText } from '@/ui/components/MathText';
import {
  clampVizHeight,
  DEFAULT_VIZ_HEIGHT,
  readVizMessage,
  VIZ_FRAME_PATH,
  VIZ_FRAME_SANDBOX,
  VIZ_HEIGHT,
  VIZ_READY,
  VIZ_RENDER,
} from '@/ui/viz-frame';

/**
 * A lesson-written visualization, run in a sandboxed frame (F3). See `@/ui/viz-frame` for why
 * the frame is a URL and not `srcdoc`, and why its sandbox omits `allow-same-origin` — the one
 * attribute here that must never be added.
 *
 * WHY the HTML is posted with target origin "*": the frame's origin is opaque, so there is no
 * origin to name. That is safe in this direction because the only window that can receive it
 * is the one `event.source` identified, and the HTML is lesson content the learner is about
 * to see anyway — nothing secret travels in it.
 */
export function InteractiveFigure({ block }: { block: InteractiveBlock }): ReactNode {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(() => clampVizHeight(block.height ?? DEFAULT_VIZ_HEIGHT));

  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      const target = frame.current?.contentWindow;
      if (target === null || target === undefined || event.source !== target) return;
      const message = readVizMessage(event.data);
      if (message === null) return;
      if (message.type === VIZ_READY) target.postMessage({ type: VIZ_RENDER, html: block.html }, '*');
      else if (message.type === VIZ_HEIGHT) setHeight(clampVizHeight(message.height));
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [block.html]);

  return (
    <figure className="la-interactive" data-testid="block-interactive">
      <MathText as="p" className="la-plot-title" text={block.title} testId="interactive-title" />
      <iframe
        ref={frame}
        // The key re-mounts the frame when the code changes, so a re-authored block starts
        // from a clean document rather than writing into the old one.
        key={block.html}
        src={VIZ_FRAME_PATH}
        sandbox={VIZ_FRAME_SANDBOX}
        referrerPolicy="no-referrer"
        title={`${block.title}. ${block.caption}`}
        className="la-interactive-frame"
        style={{ height }}
        data-testid="interactive-frame"
      />
      <MathText as="figcaption" className="la-muted" text={block.caption} testId="interactive-caption" />
    </figure>
  );
}
