// FRACTAL: covers F2 | type e2e
/**
 * Planning a curriculum, and what the subject page shows while and after it runs.
 */
import { test, expect } from './fixtures';
import { SUBJECT_A } from './seed';

test('a planned subject shows its lessons as a graph of open, done and later', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await clickTo(page.getByRole('link', { name: SUBJECT_A }).click(), /\/topics\/t_[A-Za-z0-9]{16}$/);

  await expect(page.getByRole('heading', { name: SUBJECT_A, level: 1 })).toBeVisible();
  const graph = page.getByTestId('graph-view');
  await expect(graph).toBeVisible();
  // The seeded graph is one finished lesson, three open (two unlocked by it plus a
  // second entry lesson), and one still gated: 'Channel capacity', behind an unfinished
  // prerequisite. Node placement is driven by computed availability, not by the state
  // stored on the node, which is exactly what this asserts. The capstone is also still
  // gated but is not a card in any of these lists — it has its own final-project link.
  await expect(page.getByTestId('graph-open-node')).toHaveCount(3);
  await expect(page.getByTestId('graph-done-node')).toHaveCount(1);
  await expect(page.getByTestId('graph-later-node')).toHaveCount(1);
  await expect(page.getByTestId('capstone-link')).toHaveCount(1);
});

test('planning a brand-new subject writes lessons into it', async ({ page, enter, clickTo }) => {
  await enter('/');
  await clickTo(page.getByRole('link', { name: 'Add a subject' }).click(), /\/topics\/new$/);

  await page.getByTestId('subject').fill('Queueing theory');
  await page.getByTestId('purpose').fill('Size a service without guessing');
  await page.getByTestId('create-topic').click();
  await page.getByTestId('plan-lessons').click();
  await expect(
    page.getByTestId('planning-started').or(page.getByTestId('generation-progress')),
  ).toBeVisible({ timeout: 60_000 });

  await clickTo(page.getByTestId('go-to-topic').click(), /\/topics\/t_[A-Za-z0-9]{16}$/);
  await expect(page.getByRole('heading', { name: 'Queueing theory', level: 1 })).toBeVisible();
  // Either the lessons have landed, or the page says in so many words that it is still
  // writing them. Both are correct; a blank page, a bare "nothing is open", or an error
  // is not — the subject page has to account for the work the learner just authorised.
  await expect(page.getByTestId('topic-status')).toBeVisible();
  await expect(
    page.getByTestId('graph-choice-hint').or(page.getByTestId('topic-planning')),
  ).toBeVisible({ timeout: 60_000 });
});
