// FRACTAL: covers F1, F5, F11 | type unit
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { exampleDashboardView, exampleHealthView, exampleQueueView, exampleRecoveryInfo } from '@/shapes';

const getDashboard = vi.fn();
const getHealth = vi.fn();
const getRecoveryInfo = vi.fn();
const restorePreviousCopy = vi.fn();

vi.mock('@/ui/api-client', () => ({
  getDashboard: () => getDashboard(),
  getQueue: () => Promise.resolve({ ok: true, data: exampleQueueView }),
  getHealth: () => getHealth(),
  getRecoveryInfo: () => getRecoveryInfo(),
  restorePreviousCopy: () => restorePreviousCopy(),
  getProvider: () =>
    Promise.resolve({
      ok: true,
      data: {
        provider: 'claude',
        baseUrl: 'http://127.0.0.1:11434',
        model: 'llama3.1',
        chatModel: '',
        chatBaseUrl: 'http://127.0.0.1:18081',
        available: true,
        message: null,
        keyEnvVar: null,
        keySet: false,
        remote: true,
      },
    }),
  setProvider: vi.fn(),
}));

const DashboardPage = (await import('../../app/page')).default;
const SettingsPage = (await import('../../app/settings/page')).default;
const RecoverPage = (await import('../../app/recover/page')).default;
const { DegradedCard } = await import('@/ui/components/DegradedCard');
const { resetAppStore } = await import('@/ui/store');
const { AppCliBanner, CLI_MISSING_LABEL } = await import('@/ui/components/AppCliBanner');

/** Words from this codebase that must never reach a learner's screen. */
const FORBIDDEN = [
  'job',
  'dispatch',
  'orchestrator',
  'subagent',
  'payload',
  'endpoint',
  'null',
  'undefined',
  'exception',
  'stack trace',
  'http',
  'sqlite',
  'schema',
  'correlation',
  'bearer',
  'C10',
  'store-corrupt',
  // The learner-facing word for a unit of study is "lesson" everywhere; "module" is the
  // internal name and reading both in one journey makes them look like two different things.
  'module',
];

const CODE_LIKE = /\b(200|400|401|404|409|500|503|504)\b/;

function visibleText(): string {
  return (document.body.textContent ?? '').toLowerCase();
}

function assertPlainLanguage(): void {
  const text = visibleText();
  for (const word of FORBIDDEN) {
    expect(text.includes(word.toLowerCase()), `"${word}" is developer jargon and must not be shown`).toBe(false);
  }
  expect(CODE_LIKE.test(text)).toBe(false);
}

beforeEach(() => {
  resetAppStore();
  getDashboard.mockResolvedValue({ ok: true, data: exampleDashboardView });
  getHealth.mockResolvedValue({ ok: true, data: exampleHealthView });
  getRecoveryInfo.mockResolvedValue({ ok: true, data: exampleRecoveryInfo });
  restorePreviousCopy.mockResolvedValue({ ok: true, data: { restored: true } });
});

afterEach(cleanup);

describe('user-facing language', () => {
  it('keeps the dashboard free of codebase jargon', async () => {
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByTestId('dashboard-list')).toBeTruthy());
    assertPlainLanguage();
  });

  it('keeps the settings page free of codebase jargon', async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByTestId('provider-settings')).toBeTruthy());
    assertPlainLanguage();
  });

  it('keeps the repair page free of codebase jargon', async () => {
    render(<RecoverPage />);
    await waitFor(() => expect(screen.getByTestId('recover-page')).toBeTruthy());
    assertPlainLanguage();
  });

  it('explains unreadable content without naming a file or an error code', () => {
    render(<DegradedCard title="Entropy" onRetryAuthoring={() => undefined} onDelete={() => undefined} />);
    expect(screen.getByTestId('degraded-card').textContent).toContain('could not be read');
    assertPlainLanguage();
  });

  it('shows a failed load in plain words instead of a status line', async () => {
    getDashboard.mockResolvedValue({
      ok: false,
      error: { code: 'internal', message: 'We could not load your subjects. Try again.', correlationId: 'c_2' },
    });
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByTestId('load-error')).toBeTruthy());
    expect(screen.getByTestId('load-error').textContent).toContain('We could not load your subjects.');
    assertPlainLanguage();
  });

  // WHY (H3): the banner is the one thing on every page that speaks about the machine
  // rather than the subject, so it must stay silent unless there is something the learner
  // can act on — and it must not claim anything before the answer arrives.
  it('says nothing about the helper while it is still checking, or once it is present', async () => {
    let settle: (value: unknown) => void = () => undefined;
    getHealth.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    render(<AppCliBanner />);
    expect(screen.queryByTestId('cli-banner')).toBeNull();

    settle({ ok: true, data: { ...exampleHealthView } });
    await waitFor(() => expect(getHealth).toHaveBeenCalled());
    expect(screen.queryByTestId('cli-banner')).toBeNull();
  });

  it('says the helper is missing in words the learner can act on', async () => {
    getHealth.mockResolvedValue({
      ok: true,
      data: { ...exampleHealthView, cli: { available: false, version: null, message: null } },
    });
    render(<AppCliBanner />);
    await waitFor(() => expect(screen.getByTestId('cli-banner')).toBeTruthy());
    expect(screen.getByTestId('cli-banner').textContent).toBe(CLI_MISSING_LABEL);
    assertPlainLanguage();
  });

  it('names the provider the learner actually chose, not the Claude CLI', async () => {
    getHealth.mockResolvedValue({
      ok: true,
      data: {
        ...exampleHealthView,
        provider: 'ollama',
        providerModel: 'llama3.1',
        cli: { available: false, version: null, message: null },
      },
    });
    render(<AppCliBanner />);
    await waitFor(() => expect(screen.getByTestId('cli-banner')).toBeTruthy());
    const text = screen.getByTestId('cli-banner').textContent ?? '';
    expect(text).toContain('Ollama');
    expect(text).not.toContain('Claude command-line tool');
    assertPlainLanguage();
  });

  it('prefers the repair instruction the probe worked out', async () => {
    getHealth.mockResolvedValue({
      ok: true,
      data: {
        ...exampleHealthView,
        provider: 'ollama',
        providerModel: 'llama3.1',
        cli: { available: false, version: null, message: 'Ollama is running, but llama3.1 is not pulled yet.' },
      },
    });
    render(<AppCliBanner />);
    await waitFor(() => expect(screen.getByTestId('cli-banner')).toBeTruthy());
    expect(screen.getByTestId('cli-banner').textContent).toBe(
      'Ollama is running, but llama3.1 is not pulled yet.',
    );
  });
});
