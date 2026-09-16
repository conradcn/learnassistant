// FRACTAL: covers F4 | type perf
/**
 * F4 budget: the UI acknowledges a sent answer within 100ms at p95 — the learner's own
 * message appears immediately while the tutor's reply is still in flight. What is measured
 * is the UI overhead only; the round trip is deliberately not part of it, because a slow
 * tutor must never look like a frozen page.
 */
import { test, expect, assertBudget, measureInPage } from './fixtures';
import { pastWarmUp } from '../helpers';
import { SUBJECT_A } from '../seed';

const SAMPLES = 40;
const WARMUPS = 2;
const EXCHANGES = SAMPLES + WARMUPS;

test('sending an answer is acknowledged inside the budget over a long conversation', async ({
  page,
  enterPerf,
}) => {
  test.setTimeout(600_000);

  // Open a conversation the way a learner does.
  await enterPerf('/');
  await page.getByRole('link', { name: SUBJECT_A }).click();
  await page.getByTestId('graph-open-node').getByTestId('open-module').first().click();
  await pastWarmUp(page);
  await page.getByTestId('start-evaluation').click();
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 30_000 });

  for (let i = 0; i < EXCHANGES; i += 1) {
    const settled = await page.getByTestId('chat-turn-evaluator').count();
    await page.getByTestId('chat-text').fill(`Answer number ${i}: still working it out from the distribution.`);
    // WHY measured in the page: the budget is the UI overhead of sending, and a
    // Node-side clock around these Playwright calls would record CDP round-trips
    // (~150ms of harness) instead of the handful of milliseconds the app actually
    // spends painting the learner's own message.
    await measureInPage(
      page,
      'F4',
      'chat message round-trip UI feedback',
      { trigger: 'chat-send', until: 'chat-turn-pending' },
      { warmup: i < WARMUPS, exchange: i },
    );
    // The learner's own message is on screen, and the box is still usable — a send may
    // never lock the composer while the tutor is still thinking.
    await expect(page.getByTestId('chat-turn-learner').last()).toBeVisible();
    await expect(page.getByTestId('chat-text')).toBeEditable();

    // WHY outside the clock: every turn buys its own token behind the send, and that is
    // server time, not the app's paint time — folding it into the budget would measure the
    // network. Nothing is asked of the learner in between.
    const evaluatorTurns = page.getByTestId('chat-turn-evaluator');
    await expect.poll(async () => evaluatorTurns.count(), { timeout: 60_000 }).toBeGreaterThan(settled);
  }

  const stats = assertBudget('F4', 'chat message round-trip UI feedback', 100, 95);
  expect(stats.n).toBe(SAMPLES);
});
