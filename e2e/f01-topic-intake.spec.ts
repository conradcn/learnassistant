// FRACTAL: covers F1 | type e2e
/**
 * Intake, and the work it starts.
 *
 * WHY this spec runs first: it is the only place the shipped first-run state can still be
 * observed. That state is "on and live" — this is a single-user local app, so a learner who
 * never opens Settings still gets real lessons, and nothing stands between the button they
 * pressed and the work it names.
 */
import { test, expect } from './fixtures';
import { textPdf } from '../src/source/pdf.testing';

/** The syllabus this spec uploads, written here so the assertions read against it. */
const SYLLABUS_PAGE_ONE = [
  'Course: Statistical Mechanics',
  'Unit 1: Microstates and macrostates',
  'Unit 2: The Boltzmann distribution',
];
const SYLLABUS_PAGE_TWO = ['Unit 3: Partition functions', 'Unit 4: Free energy'];

test.describe.configure({ mode: 'serial' });

test('adds a subject, and starts the AI work on it without asking twice', async ({
  page,
  enter,
  clickTo,
}) => {
  await enter('/');
  await expect(page.getByRole('heading', { name: /what you're learning/i })).toBeVisible();
  await expect(page.getByTestId('dashboard-topic').first()).toBeVisible();

  await clickTo(page.getByRole('link', { name: 'Add a subject' }).click(), /\/topics\/new$/);

  await page.getByTestId('subject').fill('Category theory');
  await page.getByTestId('level-intermediate').check();
  await page.getByTestId('purpose').fill('Read a paper without stalling on the diagrams');
  await page.getByTestId('create-topic').click();

  const created = page.getByTestId('topic-created');
  await expect(created).toBeVisible();
  await expect(created).toContainText('Category theory');

  // Pressing the button IS the authorisation: no gate, no second press.
  await page.getByTestId('plan-lessons').click();

  await expect(
    page.getByTestId('planning-started').or(page.getByTestId('generation-progress')),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('new-topic-error')).toBeHidden();
});

test('planning starts and reports progress', async ({ page, enter, clickTo }) => {
  await enter('/');
  await clickTo(page.getByRole('link', { name: 'Add a subject' }).click(), /\/topics\/new$/);

  await page.getByTestId('subject').fill('Numerical linear algebra');
  await page.getByTestId('purpose').fill('Know which decomposition to reach for');
  await page.getByTestId('create-topic').click();
  await expect(page.getByTestId('topic-created')).toBeVisible();

  await page.getByTestId('plan-lessons').click();

  await expect(
    page.getByTestId('planning-started').or(page.getByTestId('generation-progress')),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('new-topic-error')).toBeHidden();
});

test('asks what the learner already knows before offering to plan', async ({ page, enter }) => {
  await enter('/topics/new');

  await page.getByTestId('subject').fill('Matrix methods');
  await page.getByTestId('run-diagnostic').check();
  await page.getByTestId('create-topic').click();

  const question = page.getByTestId('diagnostic-question');
  await expect(question).toContainText('already worked with', { timeout: 60_000 });
  await expect(page.getByTestId('plan-lessons')).toBeHidden();

  await page.getByTestId('diagnostic-answer').fill('Matrix multiplication, mostly');
  await page.getByTestId('diagnostic-send').click();
  await expect(question).toContainText('inverted', { timeout: 60_000 });

  await page.getByTestId('diagnostic-answer').fill('Not yet');
  await page.getByTestId('diagnostic-send').click();

  await expect(page.getByTestId('diagnostic-done')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('diagnostic-panel')).toBeHidden();
  await expect(page.getByTestId('plan-lessons')).toBeVisible();
});

test('refuses an empty subject, and asks before adding a duplicate', async ({ page, enter }) => {
  await enter('/topics/new');

  await page.getByTestId('create-topic').click();
  await expect(page.getByTestId('new-topic-error')).toContainText(/Tell us what you want to learn/i);

  // A duplicate is subject *and* level, so this repeats the level the first test used.
  // At a different level it would be a legitimately different subject to learn.
  await page.getByTestId('subject').fill('Category theory');
  await page.getByTestId('level-intermediate').check();
  await page.getByTestId('purpose').fill('Same subject as before, on purpose');
  await page.getByTestId('create-topic').click();
  await expect(page.getByTestId('new-topic-error')).toContainText(/already learning/i);
  await expect(page.getByTestId('create-topic')).toHaveText(/Yes, add it again/);

  await page.getByTestId('create-topic').click();
  await expect(page.getByTestId('topic-created')).toBeVisible();
});

/**
 * The other half of intake: a learner who was handed a syllabus.
 *
 * WHY it goes all the way to `ready` rather than stopping at "planning started": the whole
 * point of the upload is that the course covers what the syllabus covers, and that is only
 * observable once the lessons exist. The PDF is built here, so what it SAYS is in the test
 * that asserts on it.
 */
test('starts a subject from an uploaded syllabus and finishes with its units as lessons', async ({
  page,
  enter,
  clickTo,
}) => {
  test.setTimeout(360_000);

  await enter('/');
  await clickTo(page.getByRole('link', { name: 'Add a subject' }).click(), /\/topics\/new$/);

  await page.getByTestId('source-file').setInputFiles({
    name: 'phys340-syllabus.pdf',
    mimeType: 'application/pdf',
    buffer: textPdf([SYLLABUS_PAGE_ONE, SYLLABUS_PAGE_TWO]),
  });

  // Read here, on this computer, while the learner is still on the form.
  const attached = page.getByTestId('source-item');
  await expect(attached).toBeVisible({ timeout: 30_000 });
  await expect(attached).toContainText('phys340-syllabus.pdf');
  await expect(page.getByTestId('source-units')).toContainText('Partition functions');

  // The subject is pre-filled from the material, and stays correctable.
  await expect(page.getByTestId('subject')).toHaveValue('Statistical Mechanics');
  await expect(page.getByTestId('subject-inferred')).toContainText('phys340-syllabus.pdf');
  await page.getByTestId('subject').fill('Statistical mechanics from my syllabus');

  await page.getByTestId('level-intermediate').check();
  await page.getByTestId('purpose').fill('Pass the course I was handed this for');
  await page.getByTestId('create-topic').click();
  await expect(page.getByTestId('topic-created')).toBeVisible();

  await page.getByTestId('plan-lessons').click();
  await expect(
    page.getByTestId('planning-started').or(page.getByTestId('generation-progress')),
  ).toBeVisible({ timeout: 60_000 });

  await clickTo(page.getByTestId('go-to-topic').click(), /\/topics\/t_[A-Za-z0-9]{16}$/);
  // The subject page reads its state once on load, the way a learner who comes back to it
  // does, so waiting for the lessons to land means coming back to it. The first press
  // planned the course; the lessons are then written a window at a time (C4/prep-window),
  // so a syllabus this size takes a press per window — which is exactly what the page
  // offers the learner each time they come back to it.
  await expect
    .poll(
      async () => {
        await page.reload();
        const status = (await page.getByTestId('topic-status').textContent()) ?? '';
        if (!/Planning|Writing/.test(status)) {
          const write = page.getByTestId('write-lessons');
          if ((await write.count()) > 0 && (await write.isEnabled())) await write.click();
        }
        return status;
      },
      { timeout: 240_000, intervals: [4_000] },
    )
    .toMatch(/Ready/);

  // Where the syllabus named a unit, there is a lesson that covers it.
  const graph = page.getByTestId('graph-view');
  await expect(graph).toBeVisible();
  for (const unit of ['Microstates and macrostates', 'Partition functions', 'Free energy']) {
    await expect(graph).toContainText(unit);
  }
});
