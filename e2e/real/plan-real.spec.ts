// FRACTAL: covers F2 | type e2e | scope real-llm
/**
 * The whole planning flow against the real Claude CLI, with no fixture standing in for
 * the model: outline the subject, authorise the writing, and wait for lessons a learner
 * can actually open.
 *
 * WHY it is its own spec, not a flag on f02: it dispatches real, billable sessions and
 * takes many minutes, so it must never run in the default suite. It is opted into by
 * pointing LA_CLAUDE_BIN at the real binary and naming this file.
 */
import { test, expect } from '../fixtures';

const FORTY_MINUTES = 40 * 60 * 1000;

test('a brand-new subject is planned and written end to end by the real CLI', async ({
  page,
  enter,
  clickTo,
}) => {
  test.setTimeout(FORTY_MINUTES);

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
  const topicUrl = page.url();
  await expect(page.getByRole('heading', { name: 'Queueing theory', level: 1 })).toBeVisible();

  // Step one: the outline. A queue that does not drain sits on `topic-planning` forever,
  // and this is where that fails.
  await waitForPage(page, topicUrl, 'outline', 12 * 60 * 1000);
  await expect(page.getByTestId('driving-question')).toBeVisible();
  await expect(page.getByTestId('graph-view')).toBeVisible();

  // Step two: the writing. It is a second press rather than part of the first because
  // what there is to write is only knowable once the outline exists.
  await page.getByTestId('write-lessons').click();

  // Step three: the lessons themselves. The card is gone once nothing is unwritten.
  await waitForPage(page, topicUrl, 'written', 25 * 60 * 1000);

  const open = await page.getByTestId('graph-open-node').count();
  const later = await page.getByTestId('graph-later-node').count();
  const done = await page.getByTestId('graph-done-node').count();
  expect(open + later + done, 'the planned subject has lessons').toBeGreaterThan(0);
  expect(open, 'at least one lesson is open to start').toBeGreaterThan(0);
});

/**
 * Reloads the subject page until it reaches `outline` (a graph is on screen) or
 * `written` (nothing is left unwritten). Returning a distinct string per state, rather
 * than asserting the absence of one, is deliberate: a poll that races page render must
 * keep waiting instead of passing on an empty page.
 */
async function waitForPage(
  page: import('@playwright/test').Page,
  topicUrl: string,
  want: 'outline' | 'written',
  timeout: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.goto(topicUrl);
        // WHY: the page fetches its own data after load, and `count()` does not wait for
        // anything. Counting straight after `goto` therefore read an empty boundary every
        // time and the poll could never see the graph. The status pill is the first thing
        // that renders once the fetch lands, so it is the gate for reading the rest.
        await expect(page.getByTestId('topic-status')).toBeVisible({ timeout: 30_000 });
        if ((await page.getByTestId('topic-planning').count()) > 0) return 'planning';
        if ((await page.getByTestId('graph-view').count()) === 0) return 'nothing';
        return (await page.getByTestId('write-lessons').count()) > 0 ? 'outline' : 'written';
      },
      { timeout, intervals: [15_000] },
    )
    .toBe(want);
}
