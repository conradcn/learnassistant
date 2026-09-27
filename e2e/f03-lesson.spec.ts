// FRACTAL: covers F3 | type e2e
/**
 * Reading a lesson: try first, then read, then choose what to do next.
 */
import { test, expect } from './fixtures';
import { pastWarmUp } from './helpers';
import { SUBJECT_A } from './seed';

// WHY a lesson per test: a first go is now kept, so a lesson another test has already
// answered reopens past the gate. Each test that needs the gate takes its own lesson.
async function openLesson(
  page: import('@playwright/test').Page,
  clickTo: (a: Promise<unknown>, r?: RegExp | string) => Promise<void>,
  title = 'Entropy',
): Promise<void> {
  await clickTo(page.getByRole('link', { name: SUBJECT_A }).click(), /\/topics\/t_[A-Za-z0-9]{16}$/);
  await clickTo(
    page.getByTestId('graph-open-node').filter({ hasText: title }).getByTestId('open-module').click(),
    /\/modules\/m_[A-Za-z0-9]{16}$/,
  );
}

test('the warm-up comes first and the explanation only appears after it', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await openLesson(page, clickTo);

  await expect(page.getByTestId('lesson-view')).toBeVisible();
  await expect(page.getByTestId('learning-goals')).toBeVisible();
  await expect(page.getByTestId('warm-up')).toHaveAttribute('data-stage', 'not-attempted');
  await expect(page.getByTestId('warm-up-prompt')).toBeVisible();
  await expect(page.getByTestId('explanation')).toBeHidden();

  await page.getByTestId('warm-up-answer').fill('Something about how surprised I should be, on average.');
  await page.getByTestId('warm-up-submit').click();

  // Optimistic: the page moves on this tick, without waiting for the note to be written.
  await expect(page.getByTestId('warm-up-settled')).toBeVisible({ timeout: 1000 });
  await expect(page.getByTestId('explanation')).toBeVisible();
  await expect(page.getByTestId('start-evaluation')).toBeVisible();
  await expect(page.getByTestId('warm-up-error')).toBeHidden();
});

test('the warm-up can be skipped, and the lesson leads back to the subject', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await openLesson(page, clickTo, 'Codes and code lengths');

  await page.getByTestId('warm-up-skip').click();
  await expect(page.getByTestId('warm-up-settled')).toContainText(/straight on/i);
  await expect(page.getByTestId('explanation')).toBeVisible();

  await clickTo(page.getByTestId('back-to-topic').click(), /\/topics\/t_[A-Za-z0-9]{16}$/);
  await expect(page.getByTestId('graph-view')).toBeVisible();
});

test('the lesson body breaks up the text with things to look at and things to do', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  // WHY pastWarmUp: f03-display-math opens this same lesson first on the shared seed.
  await openLesson(page, clickTo, 'Reading a probability table');
  await pastWarmUp(page);

  const body = page.getByTestId('lesson-blocks');
  await expect(body).toBeVisible();
  await expect(body.getByTestId('block-figure')).toBeVisible();

  // A check says nothing either way until the learner commits to an answer.
  await expect(body.getByTestId('check-feedback')).toBeHidden();
  await body.getByTestId('check-option-0').click();
  await expect(body.getByTestId('check-feedback')).toContainText(/Not that one/i);
  await body.getByTestId('check-option-1').click();
  await expect(body.getByTestId('check-feedback')).toContainText(/That is the one/i);

  // A reveal keeps its answer off the page until it is asked for.
  await expect(body.getByTestId('reveal-answer')).toBeHidden();
  await body.getByTestId('reveal-show').click();
  await expect(body.getByTestId('reveal-answer')).toBeVisible();

  // A derivation is printed whole — there is nothing to click through.
  await expect(body.getByTestId('block-steps')).toContainText('Then average');
  await expect(body.getByTestId('steps-next')).toHaveCount(0);

  // A plot redraws from its own formulas as the learner drags the slider, and can be put
  // back where it started.
  const plot = body.getByTestId('block-plot');
  await expect(plot.getByTestId('plot-value-k')).toContainText('k = 1');
  const before = await plot.getByTestId('plot-curve-0').locator('path').first().getAttribute('d');
  await plot.getByTestId('plot-slider-k').fill('3');
  await expect(plot.getByTestId('plot-value-k')).toContainText('k = 3');
  expect(await plot.getByTestId('plot-curve-0').locator('path').first().getAttribute('d')).not.toBe(before);
  await plot.getByTestId('plot-reset').click();
  await expect(plot.getByTestId('plot-value-k')).toContainText('k = 1');

  // A lesson-written visualization runs its own script — and only inside its sandbox: it
  // cannot read the page around it, the app's storage, or the network.
  const viz = body.getByTestId('block-interactive');
  await expect(viz.getByTestId('interactive-frame')).toHaveAttribute('sandbox', 'allow-scripts');
  const inside = viz.frameLocator('[data-testid="interactive-frame"]');
  await expect(inside.locator('#left')).toHaveText('16 left');
  await inside.getByRole('button', { name: 'Ask a question' }).click();
  await expect(inside.locator('#left')).toHaveText('8 left');
  await expect(inside.locator('#parent-read')).toHaveText('parent: blocked');
  await expect(inside.locator('#storage')).toHaveText('storage: blocked');
  await expect(inside.locator('#network')).toHaveText('network: blocked');

  // None of it is graded, so none of it gates what comes next.
  await expect(page.getByTestId('start-evaluation')).toBeVisible();
});

test('coming back to a lesson keeps the first go instead of asking for a new one', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  // The only lesson left with an untouched warm-up is the one behind the advisory.
  await clickTo(page.getByRole('link', { name: SUBJECT_A }).click(), /\/topics\/t_[A-Za-z0-9]{16}$/);
  await clickTo(page.getByTestId('open-later-module').first().click(), /\/modules\/m_[A-Za-z0-9]{16}$/);
  await page.getByTestId('acknowledge-advisory').click();
  await page.getByTestId('warm-up-answer').fill('My first guess, written before reading any of it.');
  await page.getByTestId('warm-up-submit').click();
  await expect(page.getByTestId('warm-up-settled')).toBeVisible();

  // Leave the lesson and walk back into it the way a learner would.
  await clickTo(page.getByTestId('back-to-topic').click(), /\/topics\/t_[A-Za-z0-9]{16}$/);
  await clickTo(page.getByTestId('open-later-module').first().click(), /\/modules\/m_[A-Za-z0-9]{16}$/);
  await page.getByTestId('acknowledge-advisory').click();

  await expect(page.getByTestId('warm-up')).toHaveAttribute('data-stage', 'attempted');
  await expect(page.getByTestId('warm-up-saved-answer')).toContainText('My first guess');
  await expect(page.getByTestId('warm-up-answer')).toBeHidden();
  await expect(page.getByTestId('explanation')).toBeVisible();
});

test('a lesson that is only suggested for later still opens if the learner insists', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await clickTo(page.getByRole('link', { name: SUBJECT_A }).click(), /\/topics\/t_[A-Za-z0-9]{16}$/);
  await clickTo(page.getByTestId('open-later-module').first().click(), /\/modules\/m_[A-Za-z0-9]{16}$/);

  await expect(page.getByTestId('prereq-advisory')).toBeVisible();
  await expect(page.getByTestId('prereq-advisory-text')).toContainText(/Entropy|Channel|before/i);
  await page.getByTestId('acknowledge-advisory').click();
  await expect(page.getByTestId('warm-up')).toBeVisible();
});

test('a link that points at no lesson says so instead of showing a blank page', async ({
  page,
  enter,
}) => {
  await enter('/modules/m_ffffffffffffffff');
  await expect(page.getByTestId('load-error')).toBeVisible();
});

test('a question about the lesson is answered on the page, and is still there on the way back', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await openLesson(page, clickTo, 'Reading a probability table');
  const skip = page.getByTestId('warm-up-skip');
  if (await skip.isVisible()) await skip.click();

  const ask = page.getByTestId('ask-panel');
  await expect(ask).toBeVisible();
  await ask.getByTestId('ask-text').fill('Why is this measured in bits and not in questions?');
  await ask.getByTestId('ask-send').click();

  await expect(ask.getByTestId('ask-answer')).toBeVisible({ timeout: 30_000 });
  await expect(ask.getByTestId('ask-history')).toContainText('measured in bits');
  // Asking is not answering: the questions are still ahead of the learner, ungated.
  await expect(page.getByTestId('start-evaluation')).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('ask-history')).toContainText('measured in bits');
});
