// FRACTAL: covers F3 | type e2e | scope a11y
/**
 * Focus order at the delete confirmation, which replaces the control the learner just pressed.
 *
 * WHY: React unmounts the focused node and the browser resets focus to <body>, leaving a
 * keyboard user at the top of a long document with nothing announced (WCAG SC 2.4.3).
 * The practice-summary half of this defect lives in f08-practice-a11y.spec.ts, which must
 * run after f07 because it consumes the shared seed's due reviews.
 */
import { test, expect } from './fixtures';
import { SUBJECT_A } from './seed';

test('asking to delete a subject moves focus into the confirmation', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await clickTo(page.getByRole('link', { name: SUBJECT_A }).click(), /\/topics\/t_[A-Za-z0-9]{16}$/);

  const remove = page.getByTestId('remove-topic');
  await expect(remove).toBeVisible();
  await remove.focus();
  await page.keyboard.press('Enter');

  const confirm = page.getByTestId('confirm-remove-topic');
  await expect(confirm).toBeFocused();
  // The focused control is inside the confirmation itself, not merely somewhere near it.
  await expect(
    page.getByTestId('remove-topic-card').getByTestId('confirm-remove-topic'),
  ).toBeFocused();

  // Backing out returns focus to the control that opened the confirmation, rather than
  // dropping it again on the way back.
  await page.getByTestId('cancel-remove-topic').click();
  await expect(page.getByTestId('remove-topic')).toBeFocused();
});
