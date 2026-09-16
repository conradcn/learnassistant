// FRACTAL: covers F2 | type e2e
/**
 * What the subject page does while the work the learner authorised is actually running.
 *
 * The regression these two guard: the page loaded once and never again. For the five to
 * ten minutes of a generation it was byte-identical — no lessons appearing, no count
 * moving — and a job that had crashed looked exactly like one still going, because the
 * "We are writing your lessons now" notice outlived the run that put it there.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { FAIL_SENTINEL, SLOW_SENTINEL } from './seed';

const TOPIC_URL = /\/topics\/t_[A-Za-z0-9]{16}$/;

/** Creates a subject through the real intake, starts it, and lands on its page. */
async function startSubject(
  page: Page,
  enter: (url?: string) => Promise<void>,
  clickTo: (action: Promise<unknown>, route?: RegExp | string) => Promise<void>,
  subject: string,
): Promise<void> {
  await enter('/topics/new');
  await page.getByTestId('subject').fill(subject);
  await page.getByTestId('purpose').fill('See what the page does while it runs');
  await page.getByTestId('create-topic').click();
  await page.getByTestId('plan-lessons').click();
  await clickTo(page.getByTestId('go-to-topic').click(), TOPIC_URL);
}

/**
 * Records every value the progress line ever shows, in the page itself.
 *
 * WHY an observer and not a poll: the count is only on screen for as long as the run is,
 * and against the fake CLI a run is seconds. A poll that happened to look after the last
 * lesson landed would find nothing and could not tell "it never moved" from "it moved
 * while I blinked". This misses nothing, and it is wiped by a reload — which is the other
 * half of what this spec claims.
 */
async function watchProgress(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __progressSeen: string[] }).__progressSeen = seen;
    const record = (): void => {
      const text = document.querySelector('[data-testid="topic-progress"]')?.textContent ?? '';
      if (text !== '' && text !== seen[seen.length - 1]) seen.push(text);
    };
    record();
    new MutationObserver(record).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
}

/** The "N of M lessons written so far" counts, in the order the page showed them. */
async function progressSeen(page: Page): Promise<number[]> {
  const texts: string[] = await page.evaluate(
    () => (window as unknown as { __progressSeen?: string[] }).__progressSeen ?? [],
  );
  return texts
    .map((text: string) => Number(/^(\d+) of \d+/.exec(text)?.[1] ?? NaN))
    .filter((n: number) => Number.isFinite(n));
}

/** How many lessons the page says are still to write, or 0 once it stops offering any. */
async function stillToWrite(page: Page): Promise<number> {
  const card = page.getByTestId('write-lessons-card');
  if ((await card.count()) === 0) return 0;
  const text = await card.innerText();
  return Number(/(\d+)\s+lessons? still to write/.exec(text)?.[1] ?? '0');
}

test('the subject page fills in as the run lands, with no reload', async ({
  page,
  enter,
  clickTo,
}) => {
  // The sentinel slows the fake CLI down to a pace a person could watch, which is the
  // only condition under which "the count climbs while you look at it" is observable.
  await startSubject(page, enter, clickTo, `Percolation on lattices ${SLOW_SENTINEL}`);
  await expect(page.getByTestId('topic-planning')).toBeVisible();

  // WHY the URL is captured: every claim below has to hold on the page the learner is
  // already looking at. If any of it only became true after a navigation, this is what
  // catches it.
  const url = page.url();
  await watchProgress(page);

  // The plan lands while the learner stands here. Before this fix the panel stayed up,
  // unchanged, until they reloaded — however long the run took.
  const modules = page.getByTestId('open-module');
  await expect.poll(() => modules.count(), { timeout: 90_000 }).toBeGreaterThan(0);

  // Second pass: the lessons themselves. "N still to write" falling IS the module count
  // rising, said the way this card says it.
  await expect(page.getByTestId('write-lessons-card')).toBeVisible();
  const before = await stillToWrite(page);
  expect(before).toBeGreaterThan(0);

  await page.getByTestId('write-lessons').click();
  await expect(page.getByTestId('topic-writing-more')).toBeVisible();

  // The count climbing is the whole claim. Nothing here reloads, so every value the
  // observer caught came off the live stream.
  await expect
    .poll(async () => Math.max(0, ...(await progressSeen(page))), { timeout: 120_000 })
    .toBeGreaterThan(0);

  // WHY the wait for the panel to go: while a pass is running the app deliberately shows
  // no "write the lessons" card at all, and reading the count out of a card that is not
  // there would score "the run has barely started" as "everything is written".
  await expect(page.getByTestId('topic-writing-more')).toHaveCount(0, { timeout: 120_000 });
  expect(await stillToWrite(page)).toBeLessThan(before);

  expect(page.url()).toBe(url);
});

test('a run that dies says so, instead of going on promising lessons', async ({
  page,
  enter,
  clickTo,
}) => {
  // The sentinel makes the fake CLI exit non-zero, so this is a genuinely failed run and
  // not a fixture pretending to be one.
  await startSubject(page, enter, clickTo, `Percolation ${FAIL_SENTINEL}`);

  await expect(page.getByTestId('topic-generation-failed')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('topic-generation-failed')).toHaveAttribute('role', 'alert');

  // Not the planning notice, and not a sentence still promising lessons: those two are
  // exactly what a crashed job used to look like.
  await expect(page.getByTestId('topic-planning')).toHaveCount(0);
  await expect(page.getByTestId('topic-writing-more')).toHaveCount(0);
  await expect(page.getByTestId('topic-message')).toHaveCount(0);
});
