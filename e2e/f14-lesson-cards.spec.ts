// FRACTAL: covers F14, F2 | type e2e
/**
 * The cards a lesson wrote for itself: shown with the lesson, added only when asked, and
 * on the learner's own shelf once they are.
 */
import { test, expect } from './fixtures';
import { SUBJECT_A } from './seed';

async function openLessonPastTheWarmUp(
  page: import('@playwright/test').Page,
  clickTo: (a: Promise<unknown>, r?: RegExp | string) => Promise<void>,
  title: string,
): Promise<void> {
  await clickTo(page.getByRole('link', { name: SUBJECT_A }).click(), /\/topics\/t_[A-Za-z0-9]{16}$/);
  await clickTo(
    page.getByTestId('graph-open-node').filter({ hasText: title }).getByTestId('open-module').click(),
    /\/modules\/m_[A-Za-z0-9]{16}$/,
  );
  await page.getByTestId('warm-up-skip').click();
  await expect(page.getByTestId('explanation')).toBeVisible();
}

test('a lesson offers its cards and puts them on the shelf when the learner asks', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await openLessonPastTheWarmUp(page, clickTo, 'Entropy');

  const pack = page.getByTestId('card-pack');
  await expect(pack).toBeVisible();
  await expect(page.getByTestId('card-pack-list')).toContainText('Entropy');
  // Nothing has been added yet: there is no deck to open.
  await expect(page.getByTestId('card-pack-deck-link')).toBeHidden();

  await page.getByTestId('add-card-pack').click();
  await expect(page.getByTestId('card-pack-message')).toContainText(/added/i);
  await expect(page.getByTestId('card-pack-error')).toBeHidden();

  // Pressing it again adds nothing and says so, rather than making a second copy.
  await page.getByTestId('add-card-pack').click();
  await expect(page.getByTestId('card-pack-message')).toContainText(/already in your cards/i);

  // And the deck is on the shelf, with the subject beside it.
  await clickTo(page.getByTestId('card-pack-deck-link').click(), /\/cards\/dk_[0-9a-f]{16}$/);
  await expect(page.getByTestId('card-list')).toContainText('Entropy');
});

test('reopening the lesson remembers that the pack was already taken', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await openLessonPastTheWarmUp(page, clickTo, 'Codes and code lengths');
  await page.getByTestId('add-card-pack').click();
  await expect(page.getByTestId('card-pack-message')).toContainText(/added/i);

  await page.reload();
  await expect(page.getByTestId('card-pack-deck-link')).toBeVisible();
  await expect(page.getByTestId('add-card-pack')).toContainText(/Check they are all/i);
});
