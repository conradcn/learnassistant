// FRACTAL: covers F7 | type e2e
/**
 * Spaced review: a list of optional cards, never a gate.
 */
import { test, expect } from './fixtures';

test('what is worth revisiting is listed, and marking one lands immediately', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await clickTo(page.getByTestId('nav-review').click(), /\/review$/);

  await expect(page.getByTestId('review-queue')).toBeVisible();
  await expect(page.getByTestId('review-header')).toBeVisible();
  const first = page.getByTestId('review-card').first();
  await expect(first).toBeVisible();

  const remembered = first.getByRole('button', { name: 'I remembered this' });
  await remembered.click();
  // Optimistic: the outcome line is there before the round trip could have finished,
  // and the buttons never lock.
  await expect(first.getByText(/come back later on/i)).toBeVisible({ timeout: 1500 });
  await expect(remembered).toBeEnabled();
  await expect(page.getByTestId('review-error')).toBeHidden();
});

test('a review card leads into the conversation for that lesson', async ({ page, enter, clickTo }) => {
  await enter('/review');
  await clickTo(
    page.getByTestId('review-card').first().getByRole('link', { name: 'Talk this one through' }).click(),
    /\/modules\/m_[A-Za-z0-9]{16}\/eval$/,
  );
  // WHY either: the whole suite shares one seeded database and runs in file order, so a
  // lesson a review card points at may already have been talked through by an earlier
  // spec. Insisting on the start button made this test pass alone and fail in the suite,
  // which says nothing about F7 — the claim is that the card lands you in the conversation
  // for that lesson, and an already-running conversation is that, not a failure. f04 makes
  // the same allowance for the same reason.
  await expect(page.getByTestId('eval-start').or(page.getByTestId('chat-text'))).toBeVisible();
});

test('reviews and mixed practice reach each other', async ({ page, enter, clickTo }) => {
  await enter('/review');
  await clickTo(page.getByRole('link', { name: 'Mixed practice instead' }).click(), /\/practice$/);
  await clickTo(page.getByRole('link', { name: 'Lessons worth revisiting' }).click(), /\/review$/);
});
