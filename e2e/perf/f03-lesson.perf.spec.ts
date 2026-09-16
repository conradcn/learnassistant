// FRACTAL: covers F3 | type perf
/**
 * F3 budgets: a lesson renders in under 200ms at p95, and first paint of the lesson page
 * lands inside 1500ms. Driven against the seeded subject at 12-lessons-per-subject scale
 * as declared, by clicking between lessons rather than reloading each time.
 */
import {
  test,
  expect,
  assertBudget,
  measure,
  installNavigationProbe,
  measureNavigation,
} from './fixtures';
import { SUBJECT_A } from '../seed';

const SAMPLES = 40;
const WARMUPS = 3;

test('a lesson renders inside its budget', async ({ page, enterPerf }) => {
  test.setTimeout(240_000);
  await enterPerf('/');
  await page.getByRole('link', { name: SUBJECT_A }).click();
  await expect(page.getByTestId('graph-view')).toBeVisible();
  const topicUrl = page.url();

  const lessons = page.getByTestId('graph-open-node').getByTestId('open-module');
  const count = await lessons.count();
  expect(count).toBeGreaterThan(1);

  await installNavigationProbe(page, 'lesson-view');

  for (let i = 0; i < WARMUPS + SAMPLES; i += 1) {
    const warmup = i < WARMUPS;
    // WHY measured in the destination document: opening a lesson is a real navigation,
    // so a Node-side clock around `click()` + `expect(...).toBeVisible()` bills two CDP
    // round-trips to the app — it read p50=171ms against a 200ms budget that no app
    // change could move. This times navigation start → the lesson being in the DOM.
    await measureNavigation(
      page,
      'F3',
      'module render',
      {
        click: () => lessons.nth(i % (count - 1)).click(),
        until: 'lesson-view',
      },
      { warmup, index: i },
    );
    await expect(page.getByTestId('lesson-view')).toBeVisible();
    await page.goto(topicUrl);
    await expect(page.getByTestId('graph-view')).toBeVisible();
  }

  assertBudget('F3', 'module render', 200, 95);
});

test('the lesson page paints inside the first-paint budget', async ({ page, enterPerf }) => {
  test.setTimeout(240_000);
  await enterPerf('/');
  await page.getByRole('link', { name: SUBJECT_A }).click();
  await expect(page.getByTestId('graph-view')).toBeVisible();
  await page.getByTestId('graph-open-node').getByTestId('open-module').first().click();
  await expect(page.getByTestId('lesson-view')).toBeVisible();
  const lessonUrl = page.url();

  for (let i = 0; i < WARMUPS + SAMPLES; i += 1) {
    await measure(
      'F3',
      'first-paint',
      async () => {
        await page.goto(lessonUrl);
        await expect(page.getByTestId('lesson-view')).toBeVisible();
      },
      { warmup: i < WARMUPS },
    );
  }

  assertBudget('F3', 'first-paint', 1500, 95);
});
