// FRACTAL: covers F11 | type e2e
/**
 * The reflection journal: notes appear as they are typed in, and can be edited.
 */
import { test, expect } from './fixtures';

test('a note appears in the journal on the tick it is saved, and can be edited', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await clickTo(page.getByTestId('nav-journal').click(), /\/journal$/);

  await expect(page.getByTestId('journal')).toBeVisible();
  await expect(page.getByTestId('journal-subject')).toBeVisible();

  const text = 'The counting argument finally clicked when I drew the tree.';
  await page.getByTestId('reflection-text').first().fill(text);
  await page.getByTestId('reflection-save').first().click();

  const entry = page.getByTestId('journal-entry').first();
  await expect(entry).toBeVisible({ timeout: 1500 });
  await expect(page.getByTestId('journal-entry-text').first()).toHaveText(text);
  await expect(page.getByTestId('reflection-error')).toBeHidden();

  await entry.getByRole('button').first().click();
  const editor = entry.getByTestId('reflection-text');
  await editor.fill(`${text} And again on the second read.`);
  await entry.getByTestId('reflection-save').click();
  await expect(page.getByTestId('journal-entry-text').first()).toContainText('second read');
});

test('the journal is per subject, and switching subjects keeps working', async ({ page, enter }) => {
  await enter('/journal');
  const picker = page.getByTestId('journal-subject');
  // WHY: allTextContents() is a single non-retrying read, so under load it could sample the
  // picker before the subjects had loaded and see only the placeholder — a flake that says
  // "the journal has one subject" when it means "the test looked too early".
  await expect
    .poll(async () => (await picker.locator('option').allTextContents()).length)
    .toBeGreaterThanOrEqual(2);
  const options = await picker.locator('option').allTextContents();
  await picker.selectOption({ label: options[1] });
  await expect(page.getByTestId('reflection-editor').first()).toBeVisible();
});
