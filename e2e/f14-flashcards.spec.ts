// FRACTAL: covers F14 | type e2e
/**
 * The flash card library: a deck for the things that just have to be memorised, a whole
 * list pasted in at once, and a study round where the back stays hidden until asked for.
 */
import { test, expect } from './fixtures';

const GROUPS = [
  'Carboxyl — -COOH',
  'Hydroxyl — -OH',
  'Amine — -NH2',
  'this line has no two sides',
].join('\n');

test('a pasted list becomes a deck, and studying it withholds the answer until asked', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await clickTo(page.getByTestId('nav-cards').click(), /\/cards$/);

  const name = `Functional groups ${Date.now()}`;
  await page.getByTestId('deck-name').fill(name);
  await page.getByTestId('deck-create').click();

  const row = page.getByTestId('deck-row').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 5000 });
  await clickTo(row.getByRole('link').click(), /\/cards\/dk_[0-9a-f]{16}$/);

  await page.getByTestId('card-paste').fill(GROUPS);
  await page.getByTestId('card-import').click();

  // Three lines split; the fourth is named rather than dropped or guessed at.
  await expect(page.getByTestId('import-message')).toContainText('3 cards added');
  await expect(page.getByTestId('import-skipped')).toContainText('no two sides');
  await expect(page.getByTestId('card-row')).toHaveCount(3);

  // One more typed in by hand.
  await page.getByTestId('card-front-input').fill('Carbonyl');
  await page.getByTestId('card-back-input').fill('C=O');
  await page.getByTestId('card-add').click();
  await expect(page.getByTestId('card-row')).toHaveCount(4);

  await page.getByTestId('deck-study').click();
  await expect(page.getByTestId('card-front')).toBeVisible();
  // The whole point: nothing on the page gives the answer away before the learner commits.
  await expect(page.getByTestId('card-back')).toBeHidden();
  await expect(page.getByTestId('card-grade-knew-it')).toBeHidden();

  await page.getByTestId('card-reveal').click();
  await expect(page.getByTestId('card-back')).toBeVisible();

  const first = await page.getByTestId('card-front').innerText();
  await page.getByTestId('card-grade-knew-it').click();
  await expect(page.getByTestId('card-front')).not.toHaveText(first, { timeout: 2000 });
  // The next card starts face down again, and nothing said how well that went.
  await expect(page.getByTestId('card-back')).toBeHidden();
  await expect(page.getByTestId('study-note')).toContainText('further out');
  await expect(page.getByTestId('study-error')).toBeHidden();
});

test('a card can be corrected, and a deck removed with its cards', async ({ page, enter, clickTo }) => {
  await enter('/cards');

  const name = `Unit prefixes ${Date.now()}`;
  await page.getByTestId('deck-name').fill(name);
  await page.getByTestId('deck-create').click();

  const row = page.getByTestId('deck-row').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 5000 });
  await clickTo(row.getByRole('link').click(), /\/cards\/dk_[0-9a-f]{16}$/);

  await page.getByTestId('card-front-input').fill('kilo');
  await page.getByTestId('card-back-input').fill('10^2');
  await page.getByTestId('card-add').click();

  const card = page.getByTestId('card-row').first();
  await card.getByRole('button', { name: 'Change it' }).click();
  await card.getByRole('textbox').nth(1).fill('10^3');
  await card.getByRole('button', { name: 'Save it' }).click();
  await expect(page.getByTestId('card-row').first()).toContainText('10^3');

  await page.getByTestId('deck-delete').click();
  await clickTo(page.getByTestId('deck-delete-confirm').click(), /\/cards$/);
  await expect(page.getByTestId('deck-row').filter({ hasText: name })).toHaveCount(0);
});
