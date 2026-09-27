// FRACTAL: covers F3 | type unit | path lesson-body-is-interleaved
import { describe, expect, it } from 'vitest';
import { exampleInteractiveBlock, lessonBlockSchema, MAX_INTERACTIVE_HTML_CHARS } from '@/shapes';
import {
  clampVizHeight,
  MAX_VIZ_HEIGHT,
  MIN_VIZ_HEIGHT,
  readVizMessage,
  VIZ_FRAME_SANDBOX,
  vizFrameDocument,
} from '@/ui/viz-frame';
import { vizFrameCsp } from '@/core/csp';
import { GET } from '../../app/viz-frame/route';

describe('the sandbox an interactive block runs in', () => {
  // WHY this is its own test and not a detail of the component test: adding
  // allow-same-origin to allow-scripts lets the frame remove its own sandbox and read the
  // session credential out of the parent. It is the one line the feature's safety rests on.
  it('allows script and never the same origin', () => {
    expect(VIZ_FRAME_SANDBOX.split(/\s+/)).toEqual(['allow-scripts']);
  });

  it('is served with its own policy, not the page one', async () => {
    const response = GET();
    expect(response.headers.get('Content-Security-Policy')).toBe(vizFrameCsp());
    expect(response.headers.get('X-Frame-Options')).toBeNull();
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(await response.text()).toBe(vizFrameDocument());
  });

  it('takes its code only from the window that framed it', () => {
    const doc = vizFrameDocument();
    expect(doc).toContain('event.source !== parent');
    expect(doc).toContain('document.write(prelude + data.html)');
  });
});

describe('what the parent will read from the frame', () => {
  it('reads the two messages it knows and nothing else', () => {
    expect(readVizMessage({ type: 'la-viz-ready' })).toEqual({ type: 'la-viz-ready' });
    expect(readVizMessage({ type: 'la-viz-height', height: 240 })).toEqual({ type: 'la-viz-height', height: 240 });
    expect(readVizMessage({ type: 'la-viz-height', height: 'tall' })).toBeNull();
    expect(readVizMessage({ type: 'la-viz-height', height: Number.POSITIVE_INFINITY })).toBeNull();
    expect(readVizMessage({ type: 'navigate', url: 'https://example.com' })).toBeNull();
    expect(readVizMessage('la-viz-ready')).toBeNull();
    expect(readVizMessage(null)).toBeNull();
  });

  it('holds a reported height to something that fits in a lesson', () => {
    expect(clampVizHeight(10)).toBe(MIN_VIZ_HEIGHT);
    expect(clampVizHeight(1e9)).toBe(MAX_VIZ_HEIGHT);
    expect(clampVizHeight(300.2)).toBe(301);
  });
});

describe('the interactive block contract', () => {
  it('takes the example as written', () => {
    expect(lessonBlockSchema.safeParse(exampleInteractiveBlock).success).toBe(true);
  });

  it('refuses code too large to be one visualization', () => {
    const html = 'x'.repeat(MAX_INTERACTIVE_HTML_CHARS + 1);
    expect(lessonBlockSchema.safeParse({ ...exampleInteractiveBlock, html }).success).toBe(false);
  });

  it('refuses a block with no caption, because the caption is its accessible name', () => {
    expect(lessonBlockSchema.safeParse({ ...exampleInteractiveBlock, caption: '' }).success).toBe(false);
  });
});
