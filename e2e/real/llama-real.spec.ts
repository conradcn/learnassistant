// FRACTAL: covers F6 | type e2e | scope real-llm
/**
 * The local llama.cpp provider, end to end, with nothing standing in for the model: the
 * learner picks llama.cpp in Settings, the app STARTS the server itself, and a real
 * subject is outlined by a model running on this machine.
 *
 * WHY it is its own spec, not a flag on f06: it loads a multi-gigabyte model and takes
 * many minutes, so it must never run in the default suite. It is opted into by naming
 * this file with LA_PROVIDER=llama and the binary and model path set.
 *
 * WHY it stops at the outline rather than waiting for every lesson: the claim under test
 * is the provider — that the server is started, the prompt is answered, and the answer
 * satisfies the same schema the Claude path does. Writing every lesson exercises the
 * orchestrator, which f02 and plan-real already cover.
 */
import { test, expect } from '../fixtures';

const THIRTY_MINUTES = 30 * 60 * 1000;

test('a subject is outlined by a llama.cpp server the app started itself', async ({
  page,
  enter,
  clickTo,
}) => {
  test.setTimeout(THIRTY_MINUTES);

  await enter('/');
  await clickTo(page.getByTestId('nav-settings').click(), /\/settings$/);

  // The provider probe is what starts the server, so this press is the whole autostart
  // claim: nothing was listening before it, and the status line only reads Ready once
  // the model is loaded and answering.
  const TEN_MINUTES = 10 * 60 * 1000;
  await page.getByTestId('provider-llama').click();
  // WHY the wait is on the status line and not the button: the press stays in flight for
  // as long as the model takes to load, and every provider button is disabled until it
  // lands. The status line settling IS the server having come up.
  await expect(page.getByTestId('provider-status')).toContainText('Ready', { timeout: TEN_MINUTES });
  await expect(page.getByTestId('provider-llama')).toHaveAttribute('aria-pressed', 'true');

  await clickTo(page.getByRole('link', { name: 'Home' }).click(), /\/$/);
  await clickTo(page.getByRole('link', { name: 'Add a subject' }).click(), /\/topics\/new$/);

  await page.getByTestId('subject').fill('How a bicycle stays upright');
  await page.getByTestId('purpose').fill('Explain it to a curious ten-year-old');
  await page.getByTestId('create-topic').click();
  await page.getByTestId('plan-lessons').click();

  await clickTo(page.getByTestId('go-to-topic').click(), /\/topics\/t_[A-Za-z0-9]{16}$/);
  const topicUrl = page.url();

  // The outline is the model's own answer, parsed and schema-checked by the same reader
  // the Claude path uses — a local model that replied in prose never gets this far.
  await expect
    .poll(
      async () => {
        await page.goto(topicUrl);
        await expect(page.getByTestId('topic-status')).toBeVisible({ timeout: 30_000 });
        if ((await page.getByTestId('topic-planning').count()) > 0) return 'planning';
        return (await page.getByTestId('graph-view').count()) > 0 ? 'outline' : 'nothing';
      },
      { timeout: 20 * 60 * 1000, intervals: [10_000] },
    )
    .toBe('outline');

  await expect(page.getByTestId('driving-question')).not.toBeEmpty();
  const nodes =
    (await page.getByTestId('graph-open-node').count()) +
    (await page.getByTestId('graph-later-node').count()) +
    (await page.getByTestId('graph-done-node').count());
  expect(nodes, 'the local model planned real modules').toBeGreaterThan(0);
});
