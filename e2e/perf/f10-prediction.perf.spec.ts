// FRACTAL: covers F10 | type perf
/**
 * F10 budget: the prediction question is on screen within 100ms of the lesson being
 * shown, and answering it is acknowledged on the same tick — it may never be the thing
 * a learner waits for.
 */
import { test, expect, assertBudget, emit, RUN_ID } from './fixtures';
import { SUBJECT_A } from '../seed';

const SAMPLES = 40;
const WARMUPS = 3;

test('the prediction prompt renders inside its budget', async ({ page, enterPerf }) => {
  test.setTimeout(240_000);
  await enterPerf('/');
  await page.getByRole('link', { name: SUBJECT_A }).click();
  await expect(page.getByTestId('graph-view')).toBeVisible();
  await page.getByTestId('graph-open-node').getByTestId('open-module').first().click();
  await expect(page.getByTestId('prediction-prompt')).toBeVisible();
  const lessonUrl = page.url();

  // WHY the clock runs inside the page, from the lesson appearing to the prompt
  // appearing: F10's budget says the prediction is on screen within 100ms *of the lesson
  // being shown*, so it is that gap that is timed. Waiting on the prompt from the test
  // process instead would fold in the whole document load and every CDP round-trip, and
  // the resulting number would describe Next.js's hydration and the test runner rather
  // than the thing the budget is about — it could never be met by changing the app.
  for (let i = 0; i < WARMUPS + SAMPLES; i += 1) {
    await page.goto(lessonUrl, { waitUntil: 'commit' });
    const durMs = await page.evaluate(
      () =>
        new Promise<number>((resolve, reject) => {
          const seen = (id: string): Element | null => document.querySelector(`[data-testid="${id}"]`);
          let lessonAt: number | null = null;
          const check = (): void => {
            if (lessonAt === null && seen('lesson-view') !== null) lessonAt = performance.now();
            if (lessonAt !== null && seen('prediction-prompt') !== null) {
              observer.disconnect();
              clearTimeout(bail);
              resolve(performance.now() - lessonAt);
            }
          };
          const observer = new MutationObserver(check);
          const bail = setTimeout(() => {
            observer.disconnect();
            reject(new Error('the prediction prompt never appeared alongside the lesson'));
          }, 30_000);
          // WHY `document` and not `document.documentElement`: the navigation is awaited
          // only to `commit`, so this can run before the root element exists — and
          // observing a null target throws. `document` is always a Node, and subtree
          // covers everything under it.
          observer.observe(document, { childList: true, subtree: true, attributes: true });
          check();
        }),
    );
    emit({
      t: new Date().toISOString(),
      run: RUN_ID,
      feature: 'F10',
      op: 'prediction prompt render',
      durMs,
      ok: true,
      meta: { warmup: i < WARMUPS },
    });
  }

  const stats = assertBudget('F10', 'prediction prompt render', 100, 95);
  expect(stats.n).toBe(SAMPLES);
});
