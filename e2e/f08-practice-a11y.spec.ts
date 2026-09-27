// FRACTAL: covers F8 | type e2e | scope a11y
/**
 * Focus and announcements in /practice, where rating a card swaps the control just pressed.
 *
 * WHY its own file, named to sort after f07: rating practice cards reschedules the shared
 * seed's due reviews. Run first (as they were, inside a11y-focus), these tests drained the
 * queue and f07 found nothing to revisit. The suite runs in file order on one database.
 */
import { test, expect } from './fixtures';

/**
 * WCAG SC 4.1.3. Unlike the two cases above this is not about focus at all — it is about
 * the swap where focus correctly does NOT move, and so nothing is spoken unless a live
 * region says it. It lives here because it is the third face of the same swap.
 */
test('rating a card announces the progress in a polite live region', async ({ page, enter }) => {
  await enter('/practice');
  const region = page.getByTestId('practice-announcement');
  await expect(region).toHaveAttribute('role', 'status');
  // Silent until there is something to report, so the region is not announced on arrival.
  await expect(region).toHaveText('');

  const stem = page.getByTestId('practice-question');
  const first = await stem.textContent();
  await page.getByTestId('practice-got-it').click();

  await expect(region).toContainText('1 answered');
  await expect(region).toContainText('Next question');
  // The buttons the rating was given through are still the focused-in-place ones, which
  // is exactly why the live region is the only thing that can speak here.
  await expect(page.getByTestId('practice-got-it')).toBeVisible();
  expect(await stem.textContent()).not.toBe(first);
});

test('the last practice rating moves focus to the summary heading', async ({ page, enter }) => {
  await enter('/practice');
  await expect(page.getByTestId('practice-runner')).toBeVisible();

  const summary = page.getByTestId('practice-summary');
  // Answer the drawn set dry. The pool is small and bounded; the guard is a cap rather
  // than a fixed count so the test does not encode the seed's exact size.
  for (let attempt = 0; attempt < 30 && !(await summary.isVisible()); attempt += 1) {
    await page.getByTestId('practice-got-it').click();
    await expect(
      summary.or(page.getByTestId('practice-question')),
    ).toBeVisible({ timeout: 10_000 });
  }
  await expect(summary).toBeVisible();

  await expect(page.getByTestId('practice-summary-heading')).toBeFocused();
  // And the ending is said out loud, not just landed on.
  await expect(page.getByTestId('practice-announcement')).toContainText(/run is (over|finished)/i);
});
