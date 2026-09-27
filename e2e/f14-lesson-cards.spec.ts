// FRACTAL: covers F14, F2 | type e2e
/**
 * The cards a lesson wrote for itself: shown with the lesson, added only when asked, and
 * on the learner's own shelf once they are.
 */
import { test, expect } from './fixtures';
import { pastWarmUp } from './helpers';
import { A_OPEN_1, A_OPEN_2 } from './seed';

// WHY by id rather than through the map: the suite shares one seed and runs in file order,
// so by now f04 has finished one of these lessons (it is no longer an open node) and an f12
// side trip also mentions "Entropy". What is under test is the card pack, not the map.
async function openLessonPastTheWarmUp(
  page: import('@playwright/test').Page,
  enter: (path: string) => Promise<void>,
  id: string,
): Promise<void> {
  await enter(`/modules/${id}`);
  await pastWarmUp(page);
}

test('a lesson offers its cards and puts them on the shelf when the learner asks', async ({
  page,
  enter,
  clickTo,
}) => {
  await openLessonPastTheWarmUp(page, enter, A_OPEN_1);

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

test('reopening the lesson remembers that the pack was already taken', async ({ page, enter }) => {
  await openLessonPastTheWarmUp(page, enter, A_OPEN_2);
  await page.getByTestId('add-card-pack').click();
  await expect(page.getByTestId('card-pack-message')).toContainText(/added/i);

  await page.reload();
  await expect(page.getByTestId('card-pack-deck-link')).toBeVisible();
  await expect(page.getByTestId('add-card-pack')).toContainText(/Check they are all/i);
});
