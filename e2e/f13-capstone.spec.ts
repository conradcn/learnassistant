// FRACTAL: covers F13 | type e2e
/**
 * The final project: hand it in, read the comments, hand it in again.
 */
import { test, expect } from './fixtures';
import { sendChat } from './helpers';
import { SUBJECT_A } from './seed';

test.describe.configure({ mode: 'serial' });

test('the final project states the question behind the subject before anything is handed in', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await clickTo(page.getByRole('link', { name: SUBJECT_A }).click(), /\/topics\/t_[A-Za-z0-9]{16}$/);
  await clickTo(page.getByTestId('capstone-link').click(), /\/topics\/t_[A-Za-z0-9]{16}\/capstone$/);

  await expect(page.getByTestId('capstone-start')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Compress a real file/ })).toBeVisible();
});

test('handing work in returns comments, and it can be handed in again', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await clickTo(page.getByRole('link', { name: SUBJECT_A }).click(), /\/topics\/t_[A-Za-z0-9]{16}$/);
  await clickTo(page.getByTestId('capstone-link').click(), /\/topics\/t_[A-Za-z0-9]{16}\/capstone$/);

  await page.getByTestId('open-capstone').click();

  const workspace = page.getByTestId('capstone-workspace');
  await expect(workspace).toBeVisible({ timeout: 30_000 });
  if (await page.getByTestId('acknowledge-capstone-advisory').isVisible()) {
    await page.getByTestId('acknowledge-capstone-advisory').click();
  }

  await sendChat(page, 'A first pass: a fixed-length coder, with the tables written out.');
  await expect(page.getByTestId('capstone-verdict')).toContainText(/improve it|passed/i);

  // Round two: the workspace is still open and still accepts work.
  await sendChat(page, 'PASS_MARKER — a Huffman coder, with each design choice justified.');
  await expect(page.getByTestId('capstone-verdict')).toBeVisible({ timeout: 60_000 });
});
