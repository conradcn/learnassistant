// FRACTAL: implements F1 | component C10
'use client';
import { useEffect, useState, type ReactNode } from 'react';
import type { ProviderKind, ProviderView } from '@/shapes';
import { getProvider, setProvider, testProviderConnection } from '@/ui/api-client';
import { QueueView } from '@/ui/components/QueueView';

/**
 * The choices, in the order they are offered.
 *
 * WHY every one of them is a plain sentence about where the model runs and what it costs
 * the learner, rather than a vendor name: the question this screen asks is "which AI
 * writes the lessons", and the answer that matters to someone choosing is whether their
 * words leave the computer and whether they need a key, not whose logo is on it.
 */
const CHOICES: { kind: ProviderKind; label: string }[] = [
  { kind: 'claude', label: 'Claude (already signed in)' },
  { kind: 'anthropic', label: 'Anthropic (your own key)' },
  { kind: 'openai', label: 'OpenAI (your own key)' },
  { kind: 'gemini', label: 'Google Gemini (your own key)' },
  { kind: 'mistral', label: 'Mistral (your own key)' },
  { kind: 'openai-compatible', label: 'Another service that speaks OpenAI' },
  { kind: 'ollama', label: 'Ollama (on this computer)' },
  { kind: 'llama', label: 'llama.cpp (on this computer)' },
];

/** WHY the file name and not the path: the ready line is a reassurance, and a 90-character
 *  path reads as a problem. The full path is still in the field above it. */
function readyDetail(provider: ProviderView): string {
  if (provider.provider === 'claude') return 'Claude is ready';
  if (provider.provider === 'llama') {
    const file = provider.model.split(/[\/]/).pop() ?? provider.model;
    return `${file} is loaded and answering`;
  }
  if (provider.model.trim().length === 0) return 'it is answering';
  return `${provider.model} is answering`;
}

/** WHY the ready line names the chat model: with two models configured, "Ready" alone
 *  leaves the learner unable to tell whether the split they just saved took effect. */
function chatSuffix(provider: ProviderView): string {
  if (provider.chatModel.trim().length === 0) return '';
  const name = provider.chatModel.split(/[\/]/).pop() ?? provider.chatModel;
  return `, with ${name} answering in conversations`;
}

function addressLabel(kind: ProviderKind | undefined): string {
  if (kind === 'llama') return 'llama.cpp address';
  if (kind === 'ollama') return 'Ollama address';
  return 'Server address';
}

function modelLabel(kind: ProviderKind | undefined): string {
  if (kind === 'llama') return 'Model file (.gguf)';
  if (kind === 'claude') return 'Model name — leave empty for your usual one';
  return 'Model name';
}

function chatModelLabel(kind: ProviderKind | undefined): string {
  if (kind === 'llama') return 'Chat model file (.gguf)';
  return 'Chat model name';
}

/**
 * WHY there is no on/off switch, no practice mode and no stop button here any more: this
 * app runs on one person's own computer, started by them. A control that asks whether the
 * thing they just clicked should really happen buys nothing and costs a click every time.
 * What is left is the one setting that changes the answer rather than permitting it —
 * which model does the work.
 */
export default function SettingsPage(): ReactNode {
  const [provider, setProviderState] = useState<ProviderView | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [chatModel, setChatModel] = useState('');
  const [chatBaseUrl, setChatBaseUrl] = useState('');
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerNote, setProviderNote] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const adopt = (next: ProviderView): void => {
    setProviderState(next);
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    setChatModel(next.chatModel);
    setChatBaseUrl(next.chatBaseUrl);
    // WHY the last test is cleared: it was the answer about a different provider, and
    // leaving a green line above a box the learner has just changed is a lie with a tick
    // next to it.
    setTestResult(null);
  };

  // WHY a load of its own: the provider probe dials a server that may not be running,
  // and the settings screen must render before that answer arrives rather than after.
  useEffect(() => {
    void getProvider().then((response) => {
      if (!response.ok) return;
      adopt(response.data);
    });
  }, []);

  const saveProvider = (next: ProviderView['provider']): void => {
    setProviderBusy(true);
    setProviderNote(null);
    void setProvider({
      provider: next,
      baseUrl: baseUrl.trim().length === 0 ? undefined : baseUrl.trim(),
      model: model.trim().length === 0 ? undefined : model.trim(),
      // WHY this one is sent even when empty: an emptied box is the learner saying "use
      // one model for both jobs again", which only reaches the config as a written ''.
      chatModel: chatModel.trim(),
      chatBaseUrl: chatBaseUrl.trim().length === 0 ? undefined : chatBaseUrl.trim(),
    }).then((response) => {
      setProviderBusy(false);
      if (!response.ok) {
        setProviderNote(response.error.message);
        return;
      }
      adopt(response.data);
    });
  };

  const runTest = (): void => {
    setTesting(true);
    setTestResult(null);
    void testProviderConnection().then((response) => {
      setTesting(false);
      setTestResult(response.ok ? response.data : { ok: false, message: response.error.message });
    });
  };

  const kind = provider?.provider;

  return (
    <>
      <h1>Settings</h1>
      <section className="la-card" data-testid="provider-settings">
        <h2>Which AI writes the lessons</h2>
        <p className="la-muted">
          A model on this computer keeps your words here — free and private, but slower and
          usually not as good. Everything else sends what you write to the company that
          runs it.
        </p>
        <div className="la-row">
          {CHOICES.map((choice) => (
            <button
              key={choice.kind}
              type="button"
              data-testid={`provider-${choice.kind}`}
              aria-pressed={kind === choice.kind}
              disabled={providerBusy}
              onClick={() => saveProvider(choice.kind)}
            >
              {choice.label}
            </button>
          ))}
        </div>
        {provider === null ? null : (
          <p className="la-muted" data-testid="provider-privacy">
            {provider.remote
              ? 'What you write is sent to this service.'
              : 'What you write stays on this computer.'}
          </p>
        )}
        {/* WHY the Claude choice has no address: it signs in itself, so there is nothing
            here a learner could point somewhere else. */}
        {kind === 'claude' ? null : (
          <label className="la-row">
            {addressLabel(kind)}
            <input
              type="text"
              data-testid="ollama-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
        )}
        <label className="la-row">
          {modelLabel(kind)}
          <input
            type="text"
            data-testid="ollama-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
        {provider === null || provider.keyEnvVar === null ? null : (
          <p className="la-muted" data-testid="provider-key">
            {/* WHY only the name of the setting and never the key itself: the key is read
                from your .env file each time it is used and is kept nowhere else, so the
                only two honest things to say are where it is read from and whether it is
                there. */}
            {provider.keySet
              ? `Your key is read from ${provider.keyEnvVar} in your .env file.`
              : `No key yet — put one in your .env file as ${provider.keyEnvVar}.`}
          </p>
        )}
        <h3>The model that answers you in a conversation</h3>
        <p className="la-muted">
          You wait for this one, so a faster model is worth it. Leave empty to use the
          same model for both.
        </p>
        <label className="la-row">
          {chatModelLabel(kind)}
          <input
            type="text"
            data-testid="chat-model"
            placeholder="same as above"
            value={chatModel}
            onChange={(e) => setChatModel(e.target.value)}
          />
        </label>
        {kind === 'llama' ? (
          <label className="la-row">
            {/* WHY only llama.cpp asks for this: one llama-server serves one model file,
                so a second model is a second server and needs its own port. */}
            Chat server address
            <input
              type="text"
              data-testid="chat-url"
              value={chatBaseUrl}
              onChange={(e) => setChatBaseUrl(e.target.value)}
            />
          </label>
        ) : null}
        <div className="la-row">
          <button
            type="button"
            data-testid="provider-save"
            disabled={providerBusy}
            onClick={() => saveProvider(kind ?? 'claude')}
          >
            Save and check it answers
          </button>
          {/* WHY a second button and not part of saving: this one spends a real answer on
              whichever model is chosen, and spending should be something the learner asked
              for rather than something that happens when they change a text box. */}
          <button
            type="button"
            data-testid="provider-test"
            disabled={providerBusy || testing}
            onClick={runTest}
          >
            {testing ? 'Asking it something…' : 'Ask it something now'}
          </button>
        </div>
        {provider === null ? null : (
          <p
            className={provider.available ? 'la-muted' : 'la-error'}
            data-testid="provider-status"
          >
            {provider.available
              ? `Ready — ${readyDetail(provider)}${chatSuffix(provider)}.`
              : (provider.message ?? 'That provider did not answer.')}
          </p>
        )}
        {testResult === null ? null : (
          <p
            className={testResult.ok ? 'la-muted' : 'la-error'}
            data-testid="provider-test-result"
          >
            {testResult.message}
          </p>
        )}
        {providerNote === null ? null : (
          <p className="la-error" role="alert" data-testid="provider-note">
            {providerNote}
          </p>
        )}
      </section>
      {/* WHY the queue lives here and not on the subject page: the subject page already
          says what is happening to THAT subject, and says it as a spinner. The question
          this answers — is the app doing anything at all, and how long has it been — is
          about the app rather than about one course, which is what settings is for. */}
      <QueueView />
    </>
  );
}
