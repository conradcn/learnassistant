// FRACTAL: covers F5 | type perf
/**
 * F5 budget: the dashboard is on screen in under 300ms at p95, at the declared scale of
 * 50 subjects (the F1 perf spec leaves that many behind; this spec tops up if it did not).
 */
import { test, expect, assertBudget, measure } from './fixtures';

const SAMPLES = 40;
const WARMUPS = 3;

test('the dashboard paints inside its budget', async ({ page, enterPerf }) => {
  test.setTimeout(240_000);
  await enterPerf('/');
  await expect(page.getByTestId('dashboard-list')).toBeVisible();
  const subjects = await page.getByTestId('dashboard-topic').count();
  expect(subjects, 'dashboard perf must run against a populated list').toBeGreaterThan(1);

  for (let i = 0; i < WARMUPS + SAMPLES; i += 1) {
    await measure(
      'F5',
      'dashboard load',
      async () => {
        await page.goto('/');
        await expect(page.getByTestId('dashboard-list')).toBeVisible();
      },
      { warmup: i < WARMUPS, subjects },
    );
  }

  const stats = assertBudget('F5', 'dashboard load', 300, 95);
  expect(stats.n).toBe(SAMPLES);
});
