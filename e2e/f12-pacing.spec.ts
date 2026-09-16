// FRACTAL: covers F12 | type e2e
/**
 * Learner-directed pacing: several lessons open at once, and a detour on request.
 */
import { test, expect } from './fixtures';
import { SUBJECT_A } from './seed';

test('several lessons are open side by side and none of them is called "next"', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await clickTo(page.getByRole('link', { name: SUBJECT_A }).click(), /\/topics\/t_[A-Za-z0-9]{16}$/);

  await expect(page.getByTestId('graph-view')).toHaveAttribute('data-open-choice', 'yes');
  await expect(page.getByTestId('graph-choice-hint')).toContainText(/Pick whichever one/i);
  await expect(page.getByRole('button', { name: /^next$/i })).toHaveCount(0);
});

test('asking to go deeper on a lesson starts it, and says so while it runs', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await clickTo(page.getByRole('link', { name: SUBJECT_A }).click(), /\/topics\/t_[A-Za-z0-9]{16}$/);

  const form = page.getByTestId('detour-form');
  await expect(form).toBeVisible();
  await page.getByTestId('request-detour').click();
  await expect(page.getByTestId('topic-message')).toContainText(/what you would like to go into|Pick which lesson/i);

  await page.getByTestId('detour-anchor').selectOption({ label: 'Entropy as expected surprise' });
  await page.getByTestId('detour-question').fill('Why is the logarithm base two rather than anything else?');

  // WHY (H2): the detour is a round-trip, and it used to render nothing at all while it was
  // in flight — no notice had been written yet, and the form still held the question with a
  // live submit button, so a detour already under way looked like a click that did nothing
  // and a second press bought a second real session. Found by the phase-10 delivery
  // walkthrough.
  //
  // The dispatch is held open here rather than raced: that window is normally too short to
  // observe, and an assertion that only passes when the machine is slow is not a check.
  let releaseDetour: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    releaseDetour = resolve;
  });
  await page.route('**/api/topics/*/detour', async (route) => {
    await held;
    await route.continue();
  });

  await page.getByTestId('request-detour').click();

  // Mid-flight: the request is out and the detour has not landed. The learner must still
  // be told something, and must not be able to buy a second session by pressing again.
  await expect(page.getByTestId('topic-message')).toBeVisible();
  await expect(page.getByTestId('request-detour')).toBeDisabled();

  releaseDetour();

  await expect(page.getByTestId('topic-message')).toContainText(/writing that extra lesson|switched off|stopped/i, {
    timeout: 30_000,
  });
});

test('extending a subject plans more lessons on top of the ones already there', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await clickTo(page.getByRole('link', { name: SUBJECT_A }).click(), /\/topics\/t_[A-Za-z0-9]{16}$/);

  const form = page.getByTestId('extend-form');
  await expect(form).toBeVisible();

  // An empty goal is a mistake, not a request: it is refused on the page rather than
  // spending a planning session on nothing.
  await page.getByTestId('request-extension').click();
  await expect(page.getByTestId('topic-message')).toContainText(/where you would like this subject to take you/i);

  const before = await page.getByTestId('graph-later-node').count();
  await page.getByTestId('extend-goal').fill('Sufficient knowledge for the MCAT');
  await page.getByTestId('request-extension').click();

  // The goal is on the page from the press, before anything has been planned for it — a
  // request in flight must not look like a click that did nothing.
  await expect(page.getByTestId('topic-message')).toBeVisible();
  await expect(page.getByTestId('topic-extensions')).toContainText(/Sufficient knowledge for the MCAT/i);

  // ...and the lessons it bought arrive in the plan the learner is already reading, with
  // everything that was there before still there.
  await expect(page.getByText('Amino acids and the peptide bond').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('graph-later-node').count()).resolves.toBeGreaterThan(before);
  await expect(page.getByRole('link', { name: 'Entropy as expected surprise' }).first()).toBeVisible();
  await expect(page.getByTestId('topic-extensions')).toContainText(/lessons added/i, { timeout: 60_000 });
});
