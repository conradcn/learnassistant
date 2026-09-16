// FRACTAL: covers (none) | type unit
import { describe, it, expect } from 'vitest';
import {
  SHAPE_REGISTRY,
  topicIdSchema,
  isoDateStringSchema,
  explanationSchema,
  assistLevelSchema,
  leavesThisMachine,
} from '@/shapes';

describe('shape conformance', () => {
  for (const { name, schema, example } of SHAPE_REGISTRY) {
    it(`${name} example validates`, () => {
      const result = schema.safeParse(example);
      expect(result.success).toBe(true);
    });
  }

  it('rejects a malformed TopicId', () => {
    expect(topicIdSchema.safeParse('t_short').success).toBe(false);
  });

  it('rejects an ISO string missing millis', () => {
    expect(isoDateStringSchema.safeParse('2026-08-22T09:14:03Z').success).toBe(false);
  });

  it('rejects an Explanation with both markdown and url', () => {
    const bad = {
      kind: 'video',
      url: 'https://example.com',
      title: 't',
      channel: 'c',
      durationSec: 1,
      why: 'w',
      markdown: 'nope',
    };
    expect(explanationSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an out-of-range AssistLevel', () => {
    expect(assistLevelSchema.safeParse(4).success).toBe(false);
  });
});

/**
 * WHY this is tested at all, when it is nine lines: this one predicate decides the sentence
 * Settings shows a learner about where their words go, and the timeout a session is given.
 * It answered "stays on this computer" for the `claude` CLI once — the CLI has no address in
 * this app's config, so an address-only test read it as local — which is the exact direction
 * of wrongness nobody checks, because a privacy promise that is too generous never gets a
 * bug report.
 */
describe('whether the words leave this computer', () => {
  it('says the Claude CLI does, even though it has no address here', () => {
    expect(leavesThisMachine('claude', '')).toBe(true);
  });

  it('says a model served on this computer does not', () => {
    expect(leavesThisMachine('ollama', 'http://127.0.0.1:11434')).toBe(false);
    expect(leavesThisMachine('llama', 'http://127.0.0.1:18080')).toBe(false);
  });

  // WHY both directions on one provider: `openai-compatible` is the adapter for OpenRouter
  // and for LM Studio on this laptop, so the provider name alone cannot answer this.
  it('answers by address on the provider that can be either', () => {
    expect(leavesThisMachine('openai-compatible', 'http://127.0.0.1:1234/v1')).toBe(false);
    expect(leavesThisMachine('openai-compatible', 'http://localhost:1234/v1')).toBe(false);
    expect(leavesThisMachine('openai-compatible', 'https://openrouter.ai/api/v1')).toBe(true);
  });

  it('says every hosted provider at its own address does', () => {
    expect(leavesThisMachine('anthropic', 'https://api.anthropic.com')).toBe(true);
    expect(leavesThisMachine('openai', 'https://api.openai.com/v1')).toBe(true);
    expect(leavesThisMachine('gemini', 'https://generativelanguage.googleapis.com/v1beta')).toBe(true);
    expect(leavesThisMachine('mistral', 'https://api.mistral.ai/v1')).toBe(true);
  });

  it('does not promise privacy for an address it cannot read', () => {
    expect(leavesThisMachine('openai-compatible', 'not a url')).toBe(true);
  });
});
