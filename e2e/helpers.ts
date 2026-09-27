// FRACTAL: covers project | type e2e | scope harness
import type { Page } from '@playwright/test';
import { expect } from './fixtures';
import { shot } from './walkthrough/fixtures';

/** Sends one answer in a Socratic chat and waits for the tutor's reply to land. */
export async function sendChat(page: Page, text: string, confidence?: 1 | 2 | 3 | 4 | 5): Promise<void> {
  const before = await page.getByTestId('chat-turn-evaluator').count();
  await page.getByTestId('chat-text').fill(text);
  if (confidence !== undefined) await page.getByTestId(`confidence-${confidence}`).click();
  await page.getByTestId('chat-send').click();
  // A turn can bring back more than one evaluator message (a remedial lesson adds a
  // second), so the wait is for the transcript to grow, not for an exact count.
  await expect
    .poll(async () => page.getByTestId('chat-turn-evaluator').count(), { timeout: 30_000 })
    .toBeGreaterThan(before);
  await shot(page, 'chat-reply-settled');
}

/**
 * Gets past the warm-up gate to the explanation below it. A lesson the learner has
 * already had a go at reopens past the gate and offers nothing to click, so a spec that
 * only wants to read the lesson must not assume the skip button is there.
 */
export async function pastWarmUp(page: Page): Promise<void> {
  const skip = page.getByTestId('warm-up-skip');
  // Wait for the page to settle on one or the other before deciding: an immediate
  // isVisible() can run before either has rendered and wrongly skip nothing.
  await expect(skip.or(page.getByTestId('explanation')).first()).toBeVisible();
  if (await skip.isVisible()) await skip.click();
  await expect(page.getByTestId('explanation')).toBeVisible();
}
