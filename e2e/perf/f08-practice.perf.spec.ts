// FRACTAL: covers F8 | type perf
/**
 * F8 budget: a practice session starts within 300ms at p95, drawn from the pool the
 * seeded store leaves behind.
 */
import { test, expect, assertBudget, measure } from './fixtures';

const SAMPLES = 40;
const WARMUPS = 3;

test('starting a practice session lands inside its budget', async ({ page, enterPerf }) => {
  test.setTimeout(240_000);
  await enterPerf('/practice');
  await expect(page.getByTestId('practice-runner').or(page.getByTestId('load-empty'))).toBeVisible();

  for (let i = 0; i < WARMUPS + SAMPLES; i += 1) {
    await measure(
      'F8',
      'session start',
      async () => {
        await page.goto('/practice');
        await expect(page.getByTestId('practice-runner').or(page.getByTestId('load-empty'))).toBeVisible();
      },
      { warmup: i < WARMUPS },
    );
  }

  const stats = assertBudget('F8', 'session start', 300, 95);
  expect(stats.n).toBe(SAMPLES);
});
