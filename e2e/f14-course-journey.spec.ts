// FRACTAL: covers F1, F2, F3, F4 | type e2e
/**
 * The whole journey on a subject that starts with nothing: add it, plan it, WRITE it, read
 * the written lesson, answer the questions, finish it.
 *
 * WHY this spec exists: every other spec starts from seeded content, so the two authored
 * steps between "add a subject" and "read a lesson" were never exercised together. That gap
 * is exactly where a learner got stuck — planning landed an outline, nothing wrote the
 * lessons, and every lesson in the new subject opened on an error card.
 */
import { test, expect } from './fixtures';
import { sendChat, pastWarmUp } from './helpers';

test.describe.configure({ mode: 'serial' });

// WHY the larger budget: this is the only spec that pays for both authored steps — an
// outline session and then one writing session per lesson, throttled to the configured
// concurrency. It is minutes of work by design, not a hang.
test.setTimeout(420_000);

const SUBJECT = 'Spectral graph theory';

test('a new subject is planned, written, read and finished', async ({ page, enter, clickTo }) => {
  await enter('/');
  await clickTo(page.getByRole('link', { name: 'Add a subject' }).click(), /\/topics\/new$/);
  await page.getByTestId('subject').fill(SUBJECT);
  await page.getByTestId('purpose').fill('Follow the eigenvalue arguments in clustering papers');
  await page.getByTestId('create-topic').click();
  await expect(page.getByTestId('topic-created')).toBeVisible();

  // Step one: the outline.
  await page.getByTestId('plan-lessons').click();
  await clickTo(page.getByRole('link', { name: 'Home' }).click(), /\/$/);
  await clickTo(
    page.getByRole('link', { name: SUBJECT }).click(),
    /\/topics\/t_[A-Za-z0-9]{16}$/,
  );

  // The outline has landed when the writing step appears.
  await expect(page.getByTestId('write-lessons')).toBeVisible({ timeout: 180_000 });

  // Before any of it is written, a lesson opened from the plan says exactly that — and is
  // never reported to the learner as a damaged saved copy.
  const openNode = page.getByTestId('graph-open-node').first().getByTestId('open-module');
  await clickTo(openNode.click(), /\/modules\/m_[A-Za-z0-9]{16}$/);
  await expect(page.getByTestId('not-written-card')).toBeVisible();
  await expect(page.getByTestId('degraded-card')).toHaveCount(0);
  await clickTo(page.getByRole('link', { name: /back to the subject/i }).first().click(), /\/topics\/t_[A-Za-z0-9]{16}$/);

  // Step two: the writing.
  const write = page.getByTestId('write-lessons');
  await expect(write).toBeVisible();
  await expect(page.getByTestId('write-lessons-card')).toContainText(/still to write/i);
  await write.click();
  await clickTo(openNode.click(), /\/modules\/m_[A-Za-z0-9]{16}$/);

  // Once written, the lesson itself is there to read.
  await expect
    .poll(
      async () => {
        await page.reload();
        return page.getByTestId('lesson-view').count();
      },
      { timeout: 240_000, intervals: [3_000] },
    )
    .toBe(1);
  await expect(page.getByTestId('learning-goals')).toBeVisible();

  // And it can be finished.
  await pastWarmUp(page);
  await clickTo(page.getByTestId('start-evaluation').click(), /\/modules\/m_[A-Za-z0-9]{16}\/eval$/);
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 30_000 });
  await sendChat(page, 'PASS_MARKER — the spectrum records how tightly the graph is connected.', 4);
  await expect(page.getByTestId('eval-outcome')).toContainText(/done/i);
});
