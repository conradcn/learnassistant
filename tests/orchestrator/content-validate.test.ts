// FRACTAL: covers F2 | type unit
import { describe, expect, it } from 'vitest';
import { exampleModuleContent, moduleContentSchema, moduleIdSchema, type ModuleId } from '@/shapes';
import { AppError } from '@/core/errors';
import {
  CONTENT_VERSION,
  MAX_CONTENT_BYTES,
  assertContentSize,
  isAllowedVideoUrl,
  loadEnvelope,
  sanitizeExplanation,
  tryValidateModuleContent,
  validateModuleContent,
  validateProposedEdges,
} from '@/orchestrator/content-validate';
import { contentDigest } from '@/orchestrator/reconcile';

function withExplanation(explanation: unknown): unknown {
  return { ...exampleModuleContent, explanation };
}

const goodVideo = {
  kind: 'video',
  url: 'https://www.youtube.com/watch?v=ErfnhcEV1O8',
  title: 'Information entropy',
  channel: '3Blue1Brown',
  durationSec: 612,
  why: 'Visual derivation at exactly this level.',
};

describe('the video-link sink', () => {
  it('accepts only https links to the allowlisted hosts', () => {
    expect(isAllowedVideoUrl('https://www.youtube.com/watch?v=abc')).toBe(true);
    expect(isAllowedVideoUrl('https://youtu.be/abc')).toBe(true);
    expect(isAllowedVideoUrl('https://vimeo.com/12345')).toBe(true);
  });

  it('refuses every other scheme, host, and shape of URL', () => {
    for (const bad of [
      'http://www.youtube.com/watch?v=abc',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'https://evil.example.com/watch?v=abc',
      'https://youtube.com.evil.example/watch?v=abc',
      'https://user:pass@www.youtube.com/watch?v=abc',
      'https://127.0.0.1/watch?v=abc',
      'https://localhost:31544/watch',
      'https://192.168.1.9/watch',
      'https://169.254.169.254/latest/meta-data',
      'not a url at all',
      '',
    ]) {
      expect(isAllowedVideoUrl(bad), bad).toBe(false);
    }
  });

  it('coerces a rejected video to plain text rather than dropping the lesson', () => {
    const { explanation, coercion } = sanitizeExplanation({ ...goodVideo, url: 'http://www.youtube.com/watch?v=abc' });
    expect(explanation.kind).toBe('text');
    expect(coercion).toContain('video link replaced with text');
    if (explanation.kind !== 'text') throw new Error('expected text');
    expect(explanation.markdown).toContain(goodVideo.title);
    expect(explanation.markdown).not.toContain('http://');
  });

  it('keeps an allowlisted video exactly as authored, with no coercion', () => {
    const { explanation, coercion } = sanitizeExplanation(goodVideo);
    expect(coercion).toBeNull();
    expect(explanation).toEqual(goodVideo);
  });
});

describe('module content ingested from the model', () => {
  it('validates against the registry shape and reports the coercion it made', () => {
    const result = validateModuleContent(withExplanation({ ...goodVideo, url: 'https://evil.example.com/v' }));
    expect(() => moduleContentSchema.parse(result.content)).not.toThrow();
    expect(result.content.explanation.kind).toBe('text');
    expect(result.coercions).toHaveLength(1);
  });

  it('rejects output that is not an object, or whose fields do not fit the shape', () => {
    for (const bad of ['a string', 42, null, []]) {
      expect(() => validateModuleContent(bad)).toThrow(AppError);
    }
    expect(() => validateModuleContent(withExplanation({ kind: 'video' }))).toThrow(AppError);
    expect(() => validateModuleContent({ ...exampleModuleContent, learningGoals: 'not a list' })).toThrow(AppError);
  });
});

describe('proposed prerequisite edges', () => {
  const a = moduleIdSchema.parse('m_71bC0d9fQ2xK4mZa');
  const b = moduleIdSchema.parse('m_0d9fQ2xK4mZa71bC');
  const foreign = moduleIdSchema.parse('m_ZZZZZZZZZZZZZZZZ');
  const known: ReadonlySet<ModuleId> = new Set([a, b]);

  it('accepts edges between modules that already exist in this topic', () => {
    expect(validateProposedEdges([{ from: a, to: b }], known)).toEqual([{ from: a, to: b }]);
  });

  it('refuses an edge naming a module id that is not part of this topic', () => {
    expect(() => validateProposedEdges([{ from: a, to: foreign }], known)).toThrow(AppError);
    expect(() => validateProposedEdges([{ from: foreign, to: a }], known)).toThrow(AppError);
  });

  it('refuses a self-loop and malformed ids outright', () => {
    expect(() => validateProposedEdges([{ from: a, to: a }], known)).toThrow(AppError);
    expect(() => validateProposedEdges([{ from: '../../etc', to: a }], known)).toThrow(AppError);
    expect(() => validateProposedEdges('edges', known)).toThrow(AppError);
  });
});

describe('the content.json deserializer', () => {
  const envelope = {
    contentVersion: CONTENT_VERSION,
    digest: contentDigest(moduleContentSchema.parse(exampleModuleContent)),
    content: exampleModuleContent,
  };

  it('loads a well-formed envelope whose digest matches', () => {
    const load = loadEnvelope(Buffer.from(JSON.stringify(envelope), 'utf8'), contentDigest);
    expect(load.ok).toBe(true);
    if (!load.ok) throw new Error(load.degradedReason);
    expect(load.content.learningGoals).toEqual(exampleModuleContent.learningGoals);
  });

  it('refuses anything past the 1 MB cap without parsing it', () => {
    const huge = Buffer.alloc(10 * 1024 * 1024, 0x7b);
    const load = loadEnvelope(huge, contentDigest);
    expect(load.ok).toBe(false);
    if (load.ok) throw new Error('expected a rejection');
    expect(load.degradedReason).toMatch(/too large/);
    expect(() => assertContentSize(huge.byteLength)).toThrow(AppError);
    expect(() => assertContentSize(MAX_CONTENT_BYTES)).not.toThrow();
  });

  it('degrades a damaged file with a reason instead of throwing raw parse text', () => {
    const load = loadEnvelope(Buffer.from('{ not json', 'utf8'), contentDigest);
    expect(load.ok).toBe(false);
    if (load.ok) throw new Error('expected a rejection');
    expect(load.degradedReason).toMatch(/damaged/);
    expect(load.degradedReason).not.toMatch(/JSON|SyntaxError/);
  });

  it('degrades a file written by a newer version rather than loading it silently', () => {
    const newer = { ...envelope, contentVersion: CONTENT_VERSION + 1 };
    const load = loadEnvelope(Buffer.from(JSON.stringify(newer), 'utf8'), contentDigest);
    expect(load.ok).toBe(false);
    if (load.ok) throw new Error('expected a rejection');
    expect(load.degradedReason).toMatch(/newer version/);
  });

  it('degrades a file whose digest does not match its content', () => {
    const tampered = {
      ...envelope,
      content: { ...exampleModuleContent, learningGoals: ['Something the digest never covered'] },
    };
    const load = loadEnvelope(Buffer.from(JSON.stringify(tampered), 'utf8'), contentDigest);
    expect(load.ok).toBe(false);
    if (load.ok) throw new Error('expected a rejection');
    expect(load.degradedReason).toMatch(/checksum/);
  });
});

// WHY these assertions are about the PATHS and not about the refusal: the refusal was
// already the behaviour. What the contract patch loop needs is the name of the field that
// was wrong, and a loop handed "it failed" has nothing to ask the model to fix.
describe('what the validator says was wrong', () => {
  it('names the block whose kind is not one the contract lists', () => {
    const withBlocks = {
      ...exampleModuleContent,
      blocks: [
        { kind: 'prose', markdown: 'Entropy is expected surprise.' },
        { kind: 'diagram', svg: '<svg viewBox="0 0 1 1"></svg>', caption: 'A diagram' },
      ],
    };
    const result = tryValidateModuleContent(withBlocks);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.startsWith('blocks.1'))).toBe(true);
  });

  it('roots an explanation problem at the explanation and not at the lesson', () => {
    const result = tryValidateModuleContent(withExplanation({ kind: 'interpretive-dance' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.every((i) => i.startsWith('explanation'))).toBe(true);
  });

  it('says so plainly when the answer was not an object at all', () => {
    const result = tryValidateModuleContent('Here is your lesson!');
    expect(result).toEqual({ ok: false, issues: ['(root):invalid_type'] });
  });

  it('still accepts a lesson the schema takes, with its coercions', () => {
    const result = tryValidateModuleContent(exampleModuleContent);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.coercions).toEqual([]);
  });
});

describe('the pack of cards a lesson may propose', () => {
  it('keeps a well-formed pack, and a lesson without one is still valid', () => {
    const withPack = tryValidateModuleContent({
      ...exampleModuleContent,
      cardPack: { name: 'The words', why: 'Nothing derives these.', cards: [{ front: 'Entropy', back: 'Expected surprise.' }] },
    });
    expect(withPack.ok).toBe(true);
    if (withPack.ok) expect(withPack.content.cardPack?.cards).toHaveLength(1);

    // Optional, and absent is the ordinary case — no empty pack is materialised.
    const without = tryValidateModuleContent({ ...exampleModuleContent });
    expect(without.ok).toBe(true);
    if (without.ok) expect(without.content.cardPack).toBeUndefined();
  });

  it('refuses a pack with a one-sided card rather than saving half of it', () => {
    const result = tryValidateModuleContent({
      ...exampleModuleContent,
      cardPack: { name: 'The words', why: '', cards: [{ front: 'Entropy', back: '' }] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(' ')).toContain('cardPack.cards.0.back');
  });

  it('refuses an empty pack: a lesson with nothing to memorise omits the key', () => {
    const result = tryValidateModuleContent({
      ...exampleModuleContent,
      cardPack: { name: 'The words', why: 'x', cards: [] },
    });
    expect(result.ok).toBe(false);
  });
});
