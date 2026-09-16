// FRACTAL: covers F3 | type unit
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  contentDigest,
  isSafeVideoUrl,
  renderMarkdown,
  renderTextWithMath,
  resetSanitizeMemo,
  sanitizeSvg,
  SVG_ATTRS,
  SVG_ELEMENTS,
} from '@/ui/sanitize';

beforeEach(() => {
  resetSanitizeMemo();
  cleanup();
});

describe('markdown sanitizer', () => {
  it('disables raw HTML in model-authored markdown', () => {
    const html = renderMarkdown('Hello <script>alert(1)</script> world');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });

  it('neutralises an onerror attribute smuggled in as raw HTML', () => {
    const html = renderMarkdown('<img src=x onerror="steal()">');
    expect(html).not.toContain('<img');
    render(<div data-testid="img" dangerouslySetInnerHTML={{ __html: html }} />);
    const node = screen.getByTestId('img');
    expect(node.querySelector('img')).toBeNull();
    expect(node.querySelectorAll('*')).toHaveLength(1);
    const inner = node.querySelector('p');
    expect(inner?.getAttributeNames()).toEqual([]);
    expect(node.textContent).toContain('onerror');
  });

  it('drops a javascript: link but keeps its visible words', () => {
    const html = renderMarkdown('[click me](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('click me');
    expect(html).not.toContain('<a ');
  });

  it('keeps an https link and marks it safe to open', () => {
    const html = renderMarkdown('[entropy](https://example.com/a)');
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('renders headings, lists and code without executing anything', () => {
    const html = renderMarkdown('# Title\n\n- one\n- two\n\n```\n<b>raw</b>\n```');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('&lt;b&gt;raw&lt;/b&gt;');
  });

  it('memoises per content digest', () => {
    const md = '# Same content';
    expect(contentDigest(md)).toBe(contentDigest('# Same content'));
    expect(contentDigest(md)).not.toBe(contentDigest('# Other content'));
    expect(renderMarkdown(md)).toBe(renderMarkdown(md));
  });

  it('is safe when the sanitised markup is actually mounted', () => {
    render(<div data-testid="md" dangerouslySetInnerHTML={{ __html: renderMarkdown('<script>x()</script>ok') }} />);
    const node = screen.getByTestId('md');
    expect(node.querySelector('script')).toBeNull();
    expect(node.textContent).toContain('ok');
  });
});

describe('svg sanitizer', () => {
  it('removes a <script> element and its contents', () => {
    const out = sanitizeSvg('<svg viewBox="0 0 10 10"><script>alert(1)</script><circle cx="1" cy="1" r="1"/></svg>');
    expect(out).not.toContain('script');
    expect(out).not.toContain('alert');
    expect(out).toContain('<circle');
  });

  it('removes a <foreignObject> element and everything inside it', () => {
    const out = sanitizeSvg('<svg><foreignObject><body onload="x()">hi</body></foreignObject><rect x="0"/></svg>');
    expect(out.toLowerCase()).not.toContain('foreignobject');
    expect(out).not.toContain('hi');
    expect(out).toContain('<rect');
  });

  it('strips event handler attributes', () => {
    const out = sanitizeSvg('<svg><circle cx="1" cy="1" r="1" onclick="steal()" onmouseover="x()"/></svg>');
    expect(out.toLowerCase()).not.toContain('onclick');
    expect(out.toLowerCase()).not.toContain('onmouseover');
    expect(out).toContain('cx="1"');
  });

  it('refuses external and inline-code references', () => {
    const out = sanitizeSvg(
      '<svg><image href="https://evil.example/x.png"/><rect fill="url(https://evil.example/f)"/><use xlink:href="#a"/></svg>',
    );
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('url(');
    expect(out).not.toContain('xlink');
  });

  it('escapes text content instead of trusting it', () => {
    const out = sanitizeSvg('<svg><text x="1">a < b & c</text></svg>');
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
  });

  it('keeps a legitimate drawing intact and mounts it without a script node', () => {
    const out = sanitizeSvg('<svg viewBox="0 0 4 4"><path d="M0 0 L4 4" stroke="#fff"/></svg>');
    expect(out).toContain('viewBox="0 0 4 4"');
    expect(out).toContain('d="M0 0 L4 4"');
    render(<div data-testid="svg" dangerouslySetInnerHTML={{ __html: out }} />);
    expect(screen.getByTestId('svg').querySelector('path')).not.toBeNull();
    expect(screen.getByTestId('svg').querySelector('script')).toBeNull();
  });

  it('memoises per content digest', () => {
    const svg = '<svg><circle r="1"/></svg>';
    expect(sanitizeSvg(svg)).toBe(sanitizeSvg(svg));
  });
});

describe('video host allowlist at render time', () => {
  it('accepts the allowlisted hosts over https', () => {
    expect(isSafeVideoUrl('https://www.youtube.com/watch?v=abc')).toBe(true);
    expect(isSafeVideoUrl('https://youtu.be/abc')).toBe(true);
    expect(isSafeVideoUrl('https://vimeo.com/123')).toBe(true);
  });

  it('refuses a non-allowlisted host, plain http, credentials and private addresses', () => {
    expect(isSafeVideoUrl('https://evil.example/watch?v=abc')).toBe(false);
    expect(isSafeVideoUrl('http://www.youtube.com/watch?v=abc')).toBe(false);
    expect(isSafeVideoUrl('https://user:pw@youtube.com/x')).toBe(false);
    expect(isSafeVideoUrl('https://127.0.0.1/x')).toBe(false);
    expect(isSafeVideoUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeVideoUrl('https://notyoutube.com.evil.example/x')).toBe(false);
  });
});

describe('HTML entities in model text', () => {
  it('decodes numeric and named entities in a diagram or table label', () => {
    expect(renderTextWithMath('rate &#8212; per second')).toBe('<p>rate — per second</p>'.replace(/<\/?p>/g, ''));
    expect(renderTextWithMath('input &rarr; output')).toContain('→');
    expect(renderTextWithMath('a &#x2192; b')).toContain('→');
    expect(renderMarkdown('x &amp; y')).toBe('<p>x &amp; y</p>');
  });

  it('leaves an unknown entity and a bare ampersand alone', () => {
    // `&amp` without its semicolon is not an entity, so it survives as literal text.
    expect(renderTextWithMath('&bogus; &amp &#xZZ;')).toBe('&amp;bogus; &amp;amp &amp;#xZZ;');
  });

  it('re-escapes markup that arrives entity-encoded', () => {
    expect(renderMarkdown('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
  });
});

/**
 * WHY these exist: the SVG sanitizer is an allowlist over UNTRUSTED model output, and an
 * allowlist only holds while it stays narrow. A future edit that adds one convenient element
 * or attribute — `use`, `style`, `href` — would silently widen the attack surface and break
 * no existing test, because every other test here asserts that legitimate diagrams still
 * render. These pin the allowlist itself and each rejection rule, so widening either is a
 * deliberate act that has to change a test.
 */
describe('svg allowlist guard', () => {
  it('pins the exact element allowlist', () => {
    expect([...SVG_ELEMENTS].sort()).toEqual([
      'circle', 'defs', 'desc', 'ellipse', 'g', 'line', 'linearGradient', 'marker', 'path',
      'polygon', 'polyline', 'radialGradient', 'rect', 'stop', 'svg', 'text', 'title', 'tspan',
    ]);
  });

  it('pins the exact attribute allowlist', () => {
    expect([...SVG_ATTRS].sort()).toEqual([
      'cx', 'cy', 'd', 'dominant-baseline', 'dx', 'dy', 'fill', 'fill-opacity', 'font-family',
      'font-size', 'font-weight', 'gradientunits', 'height', 'marker-end', 'marker-start',
      'offset', 'opacity', 'points', 'preserveaspectratio', 'r', 'rx', 'ry', 'stop-color',
      'stop-opacity', 'stroke', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin',
      'stroke-opacity', 'stroke-width', 'text-anchor', 'transform', 'viewbox', 'width', 'x',
      'x1', 'x2', 'y', 'y1', 'y2',
    ]);
  });

  it('drops an element that is not on the allowlist, together with its contents', () => {
    const html = sanitizeSvg(
      '<svg><foreignObject><div onclick="steal()">hi</div></foreignObject><rect x="1" /></svg>',
    );
    expect(html).not.toContain('foreignObject');
    expect(html).not.toContain('<div');
    expect(html).not.toContain('hi');
    expect(html).toContain('<rect x="1" />');
  });

  it.each(['script', 'use', 'image', 'animate', 'style', 'set', 'filter', 'foreignObject'])(
    'refuses the non-allowlisted element <%s>',
    (tag) => {
      expect(SVG_ELEMENTS.has(tag)).toBe(false);
      expect(sanitizeSvg(`<svg><${tag}>x</${tag}></svg>`)).toBe('<svg></svg>');
    },
  );

  it.each(['style', 'href', 'xlink:href', 'class', 'id', 'filter', 'clip-path', 'mask'])(
    'drops the non-allowlisted attribute %s',
    (attr) => {
      expect(SVG_ATTRS.has(attr)).toBe(false);
      const html = sanitizeSvg(`<svg><rect ${attr}="whatever" width="4" /></svg>`);
      expect(html).not.toContain(`${attr}=`);
      expect(html).toContain('width="4"');
    },
  );

  it('drops every on* handler, whatever its case or element', () => {
    const html = sanitizeSvg(
      '<svg onload="a()"><rect onclick="b()" ONMOUSEOVER="c()" onfocus="d()" width="4" /></svg>',
    );
    expect(html.toLowerCase()).not.toContain('on');
    expect(html).toContain('width="4"');
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:image/svg+xml;base64,PHN2Zz4='],
    ['url(', 'url(#steal)'],
    ['//', '//evil.example/x'],
    ['<', 'a<script>b'],
    ['&#', 'a&#106;b'],
    ['https://', 'https://evil.example/x'],
    ['http://', 'http://evil.example/x'],
  ])('rejects an allowlisted attribute whose value contains %s', (_label, value) => {
    const html = sanitizeSvg(`<svg><rect fill="${value}" width="4" /></svg>`);
    expect(html).toBe('<svg><rect width="4" /></svg>');
  });

  it('rejects those values case-insensitively and however deeply they are nested', () => {
    const html = sanitizeSvg('<svg><g transform="JavaScript:x"><text fill="URL(#a)">t</text></g></svg>');
    expect(html).toBe('<svg><g><text>t</text></g></svg>');
  });

  it('rejects an attribute value longer than the 4096-character cap', () => {
    const long = 'a'.repeat(4097);
    expect(sanitizeSvg(`<svg><rect fill="${long}" width="4" /></svg>`)).toBe('<svg><rect width="4" /></svg>');
    expect(sanitizeSvg(`<svg><rect fill="${'a'.repeat(4096)}" /></svg>`)).toContain('fill=');
  });

  it('renders nothing executable into the DOM for a hostile diagram', () => {
    const html = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><script>steal()</script>' +
        '<a href="javascript:alert(1)"><circle cx="5" cy="5" r="4" fill="red" /></a></svg>',
    );
    render(<div data-testid="svg" dangerouslySetInnerHTML={{ __html: html }} />);
    const node = screen.getByTestId('svg');
    expect(node.querySelector('script')).toBeNull();
    expect(node.querySelector('a')).toBeNull();
    for (const el of node.querySelectorAll('*')) {
      for (const name of el.getAttributeNames()) {
        expect(name.startsWith('on')).toBe(false);
        expect(SVG_ATTRS.has(name.toLowerCase())).toBe(true);
      }
    }
  });
});
