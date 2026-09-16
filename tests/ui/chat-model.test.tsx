// FRACTAL: covers F6 | type unit
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { exampleDashboardView, exampleHealthView, exampleProviderView, exampleQueueView } from '@/shapes';

const setProvider = vi.fn();

vi.mock('@/ui/api-client', () => ({
  getDashboard: () => Promise.resolve({ ok: true, data: exampleDashboardView }),
  getQueue: () => Promise.resolve({ ok: true, data: exampleQueueView }),
  getHealth: () => Promise.resolve({ ok: true, data: exampleHealthView }),
  getRecoveryInfo: vi.fn(),
  restorePreviousCopy: vi.fn(),
  getProvider: () =>
    Promise.resolve({
      ok: true,
      data: { ...exampleProviderView, provider: 'ollama', model: 'big', chatModel: 'small' },
    }),
  setProvider: (update: unknown) => {
    setProvider(update);
    return Promise.resolve({
      ok: true,
      data: { ...exampleProviderView, provider: 'ollama', model: 'big', chatModel: '' },
    });
  },
}));

const SettingsPage = (await import('../../app/settings/page')).default;

afterEach(() => {
  cleanup();
  setProvider.mockReset();
});

describe('the settings screen with two models', () => {
  it('shows the chat model that is configured and says it answers in conversations', async () => {
    render(<SettingsPage />);
    await waitFor(() => expect((screen.getByTestId('chat-model') as HTMLInputElement).value).toBe('small'));
    expect(screen.getByTestId('provider-status').textContent).toContain('small');
  });

  // WHY this is the case worth a test: an emptied box has to reach the server as a
  // written '', not be dropped as "nothing to change", or there is no way back to one
  // model doing both jobs.
  it('sends an emptied chat model so both roles go back to one model', async () => {
    render(<SettingsPage />);
    await waitFor(() => expect((screen.getByTestId('chat-model') as HTMLInputElement).value).toBe('small'));
    fireEvent.change(screen.getByTestId('chat-model'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('provider-save'));

    await waitFor(() => expect(setProvider).toHaveBeenCalled());
    expect(setProvider.mock.calls[0][0]).toMatchObject({ provider: 'ollama', chatModel: '' });
    await waitFor(() => expect((screen.getByTestId('chat-model') as HTMLInputElement).value).toBe(''));
  });
});
