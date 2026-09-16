// FRACTAL: covers F10 | type e2e
/**
 * The prediction before a lesson, and the calibration comparison after it passes.
 */
import { test, expect } from './fixtures';
import { sendChat, pastWarmUp } from './helpers';
import { A_SPARE, SUBJECT_A } from './seed';

test.describe.configure({ mode: 'serial' });

test('the prediction is one light question that never blocks the lesson', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await clickTo(page.getByRole('link', { name: SUBJECT_A }).click(), /\/topics\/t_[A-Za-z0-9]{16}$/);
  await clickTo(
    page.getByTestId('graph-open-node').filter({ hasText: 'Entropy' }).getByTestId('open-module').click(),
    /\/modules\/m_[A-Za-z0-9]{16}$/,
  );

  const prompt = page.getByTestId('prediction-prompt');
  await expect(prompt).toBeVisible();
  // The lesson is readable whether or not the question is answered.
  await expect(page.getByTestId('warm-up')).toBeVisible();

  await page.getByTestId('prediction-level-4').click();
  await expect(page.getByTestId('prediction-recorded')).toBeVisible({ timeout: 1500 });
  await expect(page.getByTestId('prediction-error')).toBeHidden();
});

test('skipping the prediction is a first-class answer', async ({ page, enter, clickTo }) => {
  await enter('/');
  await clickTo(page.getByRole('link', { name: SUBJECT_A }).click(), /\/topics\/t_[A-Za-z0-9]{16}$/);
  // WHY by id rather than by title text: a card also names its prerequisites, so a
  // title fragment can match a neighbouring card, and any lesson an earlier spec
  // finishes stops being open at all. A_SPARE is reserved for exactly this.
  await clickTo(
    page.locator(`[data-module-id="${A_SPARE}"]`).getByTestId('open-module').click(),
    /\/modules\/m_[A-Za-z0-9]{16}$/,
  );

  await page.getByTestId('prediction-skip').click();
  await expect(page.getByTestId('prediction-recorded')).toBeVisible({ timeout: 1500 });
  await pastWarmUp(page);
  await expect(page.getByTestId('explanation')).toBeVisible();
});

test('passing a lesson you predicted shows the comparison right there', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await clickTo(page.getByRole('link', { name: SUBJECT_A }).click(), /\/topics\/t_[A-Za-z0-9]{16}$/);
  await clickTo(
    page.getByTestId('graph-open-node').filter({ hasText: 'Entropy' }).getByTestId('open-module').click(),
    /\/modules\/m_[A-Za-z0-9]{16}$/,
  );
  await expect(page.getByTestId('prediction-recorded')).toBeVisible();

  await pastWarmUp(page);
  await clickTo(page.getByTestId('start-evaluation').click(), /\/modules\/m_[A-Za-z0-9]{16}\/eval$/);
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 30_000 });

  await sendChat(page, 'PASS_MARKER — entropy is the expectation of surprise over the distribution.', 4);

  const card = page.getByTestId('calibration-card');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('calibration-predicted')).toContainText(/You expected/i);
  await expect(page.getByTestId('calibration-actual')).toBeVisible();
  // No mark, no percentage, no letter grade anywhere in it.
  await expect(card).not.toHaveText(/%|\bgrade\b|\bscore\b/i);
});
