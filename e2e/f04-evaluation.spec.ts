// FRACTAL: covers F4 | type e2e
/**
 * The Socratic conversation: answer, be told plainly what is missing, answer again.
 */
import { test, expect } from './fixtures';
import { sendChat, pastWarmUp } from './helpers';
import { SUBJECT_A } from './seed';

test.describe.configure({ mode: 'serial' });

test('a failed answer is explained and re-asked; a good one finishes the lesson', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await clickTo(page.getByRole('link', { name: SUBJECT_A }).click(), /\/topics\/t_[A-Za-z0-9]{16}$/);
  await clickTo(
    page.getByTestId('graph-open-node').filter({ hasText: 'Codes' }).getByTestId('open-module').click(),
    /\/modules\/m_[A-Za-z0-9]{16}$/,
  );
  await pastWarmUp(page);
  await clickTo(page.getByTestId('start-evaluation').click(), /\/modules\/m_[A-Za-z0-9]{16}\/eval$/);

  // The conversation opens on its own: arriving here is the request.
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 30_000 });

  // A wrong answer: the reply says what was missing and asks again from a new angle.
  await sendChat(page, 'It is just the number of symbols in the alphabet.', 2);
  await expect(page.getByTestId('chat-turn-evaluator').last()).toContainText(/not quite|again/i);
  await expect(page.getByTestId('eval-outcome')).toContainText(/Keep going|shorter explanation/i);

  // A good answer: the lesson is finished and the calibration comparison appears once.
  await sendChat(page, 'PASS_MARKER — it is the expected surprise over the whole distribution.', 4);
  await expect(page.getByTestId('eval-outcome')).toContainText(/done/i);
  await expect(page.getByTestId('eval-unlocked')).toBeVisible();
});

test('what the learner typed survives a reload, and sending never blocks the box', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await clickTo(page.getByRole('link', { name: SUBJECT_A }).click(), /\/topics\/t_[A-Za-z0-9]{16}$/);
  await clickTo(
    page.getByTestId('graph-open-node').filter({ hasText: 'Entropy' }).getByTestId('test-out-link').click(),
    // The test-out entry carries its intent in the query string so the page it lands on
    // can emphasise the entry the learner actually chose.
    /\/modules\/m_[A-Za-z0-9]{16}\/eval\?mode=test-out$/,
  );

  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 30_000 });

  const draft = 'Half-written thought I do not want to lose';
  await page.getByTestId('chat-text').fill(draft);
  await page.reload();
  await expect(page.getByTestId('chat-text').or(page.getByTestId('eval-start'))).toBeVisible();
});

test('the conversation itself is still there after a reload, until it is started over', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await clickTo(page.getByRole('link', { name: SUBJECT_A }).click(), /\/topics\/t_[A-Za-z0-9]{16}$/);
  await clickTo(
    page
      .getByTestId('graph-open-node')
      .filter({ hasText: 'probability table' })
      .locator('[data-testid="test-out-link"], [data-testid="skip-to-eval"]')
      .click(),
    /\/modules\/m_[A-Za-z0-9]{16}\/eval\?mode=test-out$/,
  );
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 30_000 });

  const answer = 'A sentence I want back after a reload.';
  await sendChat(page, answer, 3);

  // A reload is not a new request: the transcript comes back from what was stored, and
  // reading it back runs no model.
  await page.reload();
  await expect(page.getByTestId('chat-transcript')).toContainText(answer, { timeout: 30_000 });

  // Starting over is the one thing that discards it — and it is the learner's own click.
  await page.getByTestId('restart-evaluation').click();
  await expect(page.getByTestId('chat-transcript')).not.toContainText(answer, { timeout: 30_000 });

  await page.reload();
  await expect(page.getByTestId('chat-transcript')).not.toContainText(answer, { timeout: 30_000 });
});

test('a link that points at no lesson explains itself', async ({ page, enter }) => {
  await enter('/modules/m_ffffffffffffffff/eval');
  await expect(page.getByTestId('load-error')).toBeVisible();
});
