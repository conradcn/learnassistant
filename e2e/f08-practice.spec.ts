// FRACTAL: covers F8 | type e2e
/**
 * Interleaved practice: questions drawn across subjects, stoppable at any point.
 */
import { test, expect } from './fixtures';

test('a practice run asks questions one at a time and records each mark on the spot', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await clickTo(page.getByTestId('nav-practice').click(), /\/practice$/);

  await expect(page.getByTestId('practice-runner')).toBeVisible();
  const progress = page.getByTestId('practice-progress');
  await expect(progress).toBeVisible();
  const firstQuestion = await page.getByTestId('practice-question').innerText();

  await page.getByTestId('practice-got-it').click();
  // Optimistic: the next question is on screen before the answer has been written.
  await expect(page.getByTestId('practice-question')).not.toHaveText(firstQuestion, { timeout: 1500 });
  await expect(page.getByTestId('practice-error')).toBeHidden();
});

test('stopping early keeps everything already answered', async ({ page, enter }) => {
  await enter('/practice');
  await expect(page.getByTestId('practice-runner')).toBeVisible();

  // WHY only one answer before stopping: the run ends on its own once every drawn
  // question is answered, and the seeded pool is small. Answering the pool dry would
  // exercise the "finished" summary, not the "stopped early" one this test is about,
  // so exactly one question is answered while at least one is still outstanding.
  await page.getByTestId('practice-got-it').click();
  await expect(page.getByTestId('practice-stop')).toBeVisible();
  await page.getByTestId('practice-stop').click();

  const summary = page.getByTestId('practice-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText(/stopped/i);
  await expect(page.getByTestId('practice-kept-question')).toHaveCount(1);
});
