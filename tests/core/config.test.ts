// FRACTAL: covers (none) | type unit
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resetConfigCache, saveConfig } from '@/core/config';

describe('loadConfig', () => {
  let dir: string;
  let originalDataRoot: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'la-config-test-'));
    originalDataRoot = process.env.LA_DATA_ROOT;
    process.env.LA_DATA_ROOT = dir;
    resetConfigCache();
  });

  afterEach(() => {
    if (originalDataRoot === undefined) delete process.env.LA_DATA_ROOT;
    else process.env.LA_DATA_ROOT = originalDataRoot;
    delete process.env.LA_PROVIDER;
    delete process.env.LA_OLLAMA_URL;
    delete process.env.LA_OLLAMA_MODEL;
    delete process.env.LA_CHAT_OLLAMA_MODEL;
    delete process.env.PORT;
    rmSync(dir, { recursive: true, force: true });
    resetConfigCache();
  });

  it('falls back to full defaults and warns naming the file when config.json is unparseable', () => {
    writeFileSync(path.join(dir, 'config.json'), '{not json', 'utf8');
    const cfg = loadConfig();
    expect(cfg.port).toBe(31544);
    expect(cfg.configWarnings.some((w) => w.includes('config.json'))).toBe(true);
  });

  it('drops an out-of-range field to its default and warns naming the field', () => {
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: -5 }), 'utf8');
    const cfg = loadConfig();
    expect(cfg.port).toBe(31544);
    expect(cfg.configWarnings.some((w) => w.includes('port'))).toBe(true);
  });

  it('silently strips unknown keys', () => {
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mysteryKey: 'x', port: 4000 }), 'utf8');
    const cfg = loadConfig();
    expect(cfg.port).toBe(4000);
    expect((cfg as unknown as Record<string, unknown>).mysteryKey).toBeUndefined();
  });

  it('never throws for a broken file, a bad env var, or a missing directory', () => {
    writeFileSync(path.join(dir, 'config.json'), '{not json', 'utf8');
    process.env.PORT = 'not-a-number';
    expect(() => loadConfig()).not.toThrow();
  });

  it('saveConfig round-trips a valid patch', () => {
    const updated = saveConfig({ port: 4321 });
    expect(updated.port).toBe(4321);
    resetConfigCache();
    const reloaded = loadConfig();
    expect(reloaded.port).toBe(4321);
    const onDisk = JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'));
    expect(onDisk.port).toBe(4321);
  });

  it('saveConfig rejects an invalid patch', () => {
    expect(() => saveConfig({ port: -1 })).toThrow();
  });

  it('handles a directory that does not yet exist', () => {
    const nested = path.join(dir, 'nested', 'deeper');
    mkdirSync(path.dirname(nested), { recursive: true });
    process.env.LA_DATA_ROOT = nested;
    resetConfigCache();
    expect(() => loadConfig()).not.toThrow();
  });
});

describe('choosing the provider', () => {
  let dir: string;
  let originalDataRoot: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'la-provider-test-'));
    originalDataRoot = process.env.LA_DATA_ROOT;
    process.env.LA_DATA_ROOT = dir;
    resetConfigCache();
  });

  afterEach(() => {
    if (originalDataRoot === undefined) delete process.env.LA_DATA_ROOT;
    else process.env.LA_DATA_ROOT = originalDataRoot;
    delete process.env.LA_PROVIDER;
    delete process.env.LA_OLLAMA_URL;
    delete process.env.LA_OLLAMA_MODEL;
    rmSync(dir, { recursive: true, force: true });
    resetConfigCache();
  });

  it('ships pointed at Claude, with a local default ready to switch to', () => {
    const cfg = loadConfig();
    expect(cfg.provider).toBe('claude');
    expect(cfg.ollama.baseUrl).toBe('http://127.0.0.1:11434');
  });

  it('reads the provider and the local model from config.json', () => {
    writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ provider: 'ollama', ollama: { baseUrl: 'http://localhost:1234', model: 'qwen2.5' } }),
      'utf8',
    );
    const cfg = loadConfig();
    expect(cfg.provider).toBe('ollama');
    expect(cfg.ollama).toEqual({ baseUrl: 'http://localhost:1234', model: 'qwen2.5' });
  });

  it('lets the environment override both', () => {
    process.env.LA_PROVIDER = 'ollama';
    process.env.LA_OLLAMA_MODEL = 'mistral';
    const cfg = loadConfig();
    expect(cfg.provider).toBe('ollama');
    expect(cfg.ollama.model).toBe('mistral');
  });

  // WHY: the base URL is dialled by the server process, so a value fetch could never
  // honour has to be refused where it is entered, not at 3am inside a failed session.
  it('refuses an address that is not an http url and warns naming the field', () => {
    process.env.LA_OLLAMA_URL = 'file:///etc/passwd';
    const cfg = loadConfig();
    expect(cfg.ollama.baseUrl).toBe('http://127.0.0.1:11434');
    expect(cfg.configWarnings.some((w) => w.includes('LA_OLLAMA_URL'))).toBe(true);
  });

  it('writes the provider choice to disk so it survives a restart', () => {
    saveConfig({ provider: 'ollama', ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5' } });
    resetConfigCache();
    const cfg = loadConfig();
    expect(cfg.provider).toBe('ollama');
    expect(cfg.ollama.model).toBe('qwen2.5');
  });

  it('refuses to save a provider it does not have', () => {
    expect(() => saveConfig({ provider: 'gpt' as 'claude' })).toThrow();
  });

  it('reads a separate chat model from config.json and leaves the planning model alone', () => {
    writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({
        provider: 'ollama',
        ollama: { baseUrl: 'http://localhost:1234', model: 'big' },
        chatModels: { ollama: 'small' },
      }),
      'utf8',
    );
    const cfg = loadConfig();
    expect(cfg.ollama.model).toBe('big');
    expect(cfg.chatModels.ollama).toBe('small');
    expect(cfg.configWarnings).toEqual([]);
  });

  it('writes both models to disk so the split survives a restart', () => {
    saveConfig({
      claudeModel: 'claude-opus-5',
      chatModels: { claude: 'claude-haiku-4-5-20251001', ollama: '', llama: { baseUrl: 'http://127.0.0.1:18081', modelPath: '' } },
    });
    resetConfigCache();
    const cfg = loadConfig();
    expect(cfg.claudeModel).toBe('claude-opus-5');
    expect(cfg.chatModels.claude).toBe('claude-haiku-4-5-20251001');
  });

  // WHY '' is a value and not a rejection: it is how the learner says "one model for
  // both jobs again", and refusing it would leave no way back from a split.
  it('accepts an emptied chat model as going back to one model for both roles', () => {
    saveConfig({ chatModels: { claude: 'x', ollama: '', llama: { baseUrl: 'http://127.0.0.1:18081', modelPath: '' } } });
    saveConfig({ chatModels: { claude: '', ollama: '', llama: { baseUrl: 'http://127.0.0.1:18081', modelPath: '' } } });
    resetConfigCache();
    expect(loadConfig().chatModels.claude).toBe('');
  });

  it('lets the environment name the chat model', () => {
    process.env.LA_CHAT_OLLAMA_MODEL = 'small';
    expect(loadConfig().chatModels.ollama).toBe('small');
  });

  // WHY this address is refused where a model name is not: it is dialled to START a
  // second llama-server, so an address fetch cannot honour is a session failure later.
  it('refuses a chat server address that is not an http url', () => {
    expect(() =>
      saveConfig({ chatModels: { claude: '', ollama: '', llama: { baseUrl: 'not a url', modelPath: '' } } }),
    ).toThrow();
  });
});
