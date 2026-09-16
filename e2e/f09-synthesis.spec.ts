// FRACTAL: covers F9 | type e2e
/**
 * Linking two subjects: the question must name both of them.
 */
import { test, expect } from './fixtures';
import { SUBJECT_A, SUBJECT_B } from './seed';

test('the question names both subjects, and opens as a conversation', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await clickTo(page.getByTestId('nav-synthesis').click(), /\/synthesis$/);

  await expect(page.getByTestId('synthesis-picker')).toBeVisible();
  await page.getByTestId('synthesis-first').selectOption({ label: SUBJECT_A });
  await page.getByTestId('synthesis-second').selectOption({ label: SUBJECT_B });

  const preview = page.getByTestId('synthesis-preview');
  await expect(preview).toContainText(SUBJECT_A);
  await expect(preview).toContainText(SUBJECT_B);

  await page.getByTestId('synthesis-start').click();
  await expect(
    page.getByTestId('synthesis-opened').or(page.getByTestId('synthesis-error')),
  ).toBeVisible({ timeout: 30_000 });
});

test('the same subject cannot be picked twice', async ({ page, enter }) => {
  await enter('/synthesis');
  await page.getByTestId('synthesis-first').selectOption({ label: SUBJECT_A });

  // The pair is never allowed to collide: the second list simply does not offer whatever
  // the first holds, so there is no state in which the user has to be told off for it.
  const second = page.getByTestId('synthesis-second');
  await expect(second.locator('option', { hasText: SUBJECT_A })).toHaveCount(0);
  await expect(second).not.toHaveValue(await page.getByTestId('synthesis-first').inputValue());
  await expect(page.getByTestId('synthesis-start')).toBeEnabled();
});
