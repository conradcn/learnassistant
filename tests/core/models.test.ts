// FRACTAL: covers F6 | type unit
import { describe, it, expect } from 'vitest';
import type { AppConfig } from '@/shapes';
import { exampleAppConfig } from '@/shapes';
import {
  claudeModelFor,
  llamaSettingsFor,
  ollamaSettingsFor,
  roleOfKind,
} from '@/core/models';

function config(patch: Partial<AppConfig>): AppConfig {
  return { ...exampleAppConfig, ...patch };
}

describe('roleOfKind', () => {
  it('sends only the learner-facing turn to the chat role', () => {
    expect(roleOfKind('evaluate')).toBe('chat');
    for (const kind of ['author-module', 'generate-topic', 'capstone-spec', 'detour', 'review-question'] as const) {
      expect(roleOfKind(kind)).toBe('planning');
    }
  });
});

describe('model resolution', () => {
  it('uses the planning model for both roles when no chat model is set', () => {
    const cfg = config({ provider: 'ollama', ollama: { baseUrl: 'http://x:1', model: 'big' } });
    expect(ollamaSettingsFor(cfg, 'planning').model).toBe('big');
    expect(ollamaSettingsFor(cfg, 'chat').model).toBe('big');
  });

  it('gives chat its own Ollama model without moving the address', () => {
    const cfg = config({
      provider: 'ollama',
      ollama: { baseUrl: 'http://x:1', model: 'big' },
      chatModels: { ...exampleAppConfig.chatModels, ollama: 'small' },
    });
    expect(ollamaSettingsFor(cfg, 'planning').model).toBe('big');
    expect(ollamaSettingsFor(cfg, 'chat')).toEqual({ baseUrl: 'http://x:1', model: 'small' });
  });

  it('gives a llama.cpp chat model its own server address, keeping the same binary', () => {
    const cfg = config({
      provider: 'llama',
      llama: { baseUrl: 'http://127.0.0.1:18080', binPath: 'llama-server', modelPath: '/m/big.gguf' },
      chatModels: {
        ...exampleAppConfig.chatModels,
        llama: { baseUrl: 'http://127.0.0.1:18081', modelPath: '/m/small.gguf' },
      },
    });
    expect(llamaSettingsFor(cfg, 'planning')).toEqual({
      baseUrl: 'http://127.0.0.1:18080',
      binPath: 'llama-server',
      modelPath: '/m/big.gguf',
    });
    expect(llamaSettingsFor(cfg, 'chat')).toEqual({
      baseUrl: 'http://127.0.0.1:18081',
      binPath: 'llama-server',
      modelPath: '/m/small.gguf',
    });
  });

  it('keeps both roles on one llama.cpp server when no chat model file is chosen', () => {
    const cfg = config({
      provider: 'llama',
      llama: { baseUrl: 'http://127.0.0.1:18080', binPath: 'llama-server', modelPath: '/m/big.gguf' },
    });
    expect(llamaSettingsFor(cfg, 'chat').baseUrl).toBe('http://127.0.0.1:18080');
  });

  it('falls back from an unset chat model to the planning model, and from that to the CLI default', () => {
    const none = config({ provider: 'claude' });
    expect(claudeModelFor(none, 'planning')).toBeNull();
    expect(claudeModelFor(none, 'chat')).toBeNull();

    const planning = config({ provider: 'claude', claudeModel: 'claude-opus-5' });
    expect(claudeModelFor(planning, 'chat')).toBe('claude-opus-5');

    const split = config({
      provider: 'claude',
      claudeModel: 'claude-opus-5',
      chatModels: { ...exampleAppConfig.chatModels, claude: 'claude-haiku-4-5-20251001' },
    });
    expect(claudeModelFor(split, 'planning')).toBe('claude-opus-5');
    expect(claudeModelFor(split, 'chat')).toBe('claude-haiku-4-5-20251001');
  });

  it('treats a whitespace-only override as unset rather than as a model named " "', () => {
    const cfg = config({
      provider: 'ollama',
      ollama: { baseUrl: 'http://x:1', model: 'big' },
      chatModels: { ...exampleAppConfig.chatModels, ollama: '   ' },
    });
    expect(ollamaSettingsFor(cfg, 'chat').model).toBe('big');
  });
});
