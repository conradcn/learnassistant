// FRACTAL: covers F5 | type e2e
/**
 * The dashboard: where you are, in sentences rather than percentages.
 */
import { test, expect } from './fixtures';
import { SUBJECT_A, SUBJECT_B } from './seed';

test('every subject is listed with a plain-language line about where it stands', async ({
  page,
  enter,
}) => {
  await enter('/');
  const cards = page.getByTestId('dashboard-topic');
  await expect(cards.filter({ hasText: SUBJECT_A })).toBeVisible();
  await expect(cards.filter({ hasText: SUBJECT_B })).toBeVisible();

  const line = page.getByTestId('progress-line').first();
  await expect(line).toBeVisible();
  await expect(line).not.toHaveText(/%/);
});

test('the dashboard is the way in to reviews, practice, notes and settings', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await clickTo(page.getByRole('link', { name: /ready to review/ }).click(), /\/review$/);
  await clickTo(page.getByRole('link', { name: 'Home' }).click(), /\/$/);
  await clickTo(page.getByTestId('nav-practice').click(), /\/practice$/);
  await clickTo(page.getByRole('link', { name: 'Home' }).click(), /\/$/);
  await clickTo(page.getByTestId('nav-settings').click(), /\/settings$/);
  await expect(page.getByTestId('provider-settings')).toBeVisible();
});
