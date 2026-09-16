// FRACTAL: covers F1 | type perf
/**
 * F1 budget: submitting a new subject gives feedback in under 100ms at p95.
 * Measured over the declared scale of 50 subjects, so the list the write lands in is
 * the size a real one reaches rather than an empty table.
 */
import { test, expect, assertBudget, measureInPage } from './fixtures';

const SCALE_TOPICS = 50;
const SAMPLES = 40;

test('submitting a subject answers inside the budget at 50 subjects', async ({ page, enterPerf }) => {
  test.setTimeout(300_000);
  await enterPerf('/topics/new');

  for (let i = 0; i < SCALE_TOPICS + SAMPLES; i += 1) {
    const warmup = i < SCALE_TOPICS;
    await page.getByTestId('subject').fill(`Perf subject ${i}`);
    await page.getByTestId('purpose').fill('Fill the list out to the scale the budget is declared at');
    // WHY measured in the page: the budget is the UI overhead of the submit, and a
    // Node-side clock around two Playwright calls records the CDP round-trips instead
    // (~150ms of harness against ~10ms of app), which no change to the app could fix.
    await measureInPage(
      page,
      'F1',
      'submit',
      { trigger: 'create-topic', until: 'topic-created' },
      { warmup, index: i },
    );
    await expect(page.getByTestId('topic-created')).toBeVisible();
    await page.goto('/topics/new');
  }

  const stats = assertBudget('F1', 'submit', 100, 95);
  expect(stats.n).toBe(SAMPLES);
});
