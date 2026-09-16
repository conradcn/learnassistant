// FRACTAL: covers F4 | type e2e | scope real-llm
/**
 * One talk-through turn against the real Claude CLI, with no fixture standing in for the
 * model. This is the flow that reported "The evaluator did not respond" in real use — a
 * failure the fake CLI can never show, because the fake always answers in exactly the
 * shape the parser wants.
 *
 * WHY it is its own spec: it dispatches real, billable sessions. It is opted into by
 * pointing LA_CLAUDE_BIN at the real binary and running the `real` project.
 */
import { test, expect } from '../fixtures';
import { SUBJECT_A } from '../seed';

const TEN_MINUTES = 10 * 60 * 1000;

test('the real evaluator answers a talk-through turn', async ({ page, enter, clickTo }) => {
  test.setTimeout(TEN_MINUTES);

  await enter('/');
  await clickTo(page.getByRole('link', { name: SUBJECT_A }).click(), /\/topics\/t_[A-Za-z0-9]{16}$/);
  const entry = page
    .getByTestId('graph-open-node')
    .filter({ hasText: 'Entropy' })
    .getByTestId('test-out-link');
  // WHY the explicit short timeout: the test budget is sized for the real model's own
  // thinking time, and without this a mistyped selector spends all of it waiting.
  await expect(entry).toBeVisible({ timeout: 15_000 });
  await clickTo(entry.click(), /\/modules\/m_[A-Za-z0-9]{16}\/eval\?mode=test-out$/);

  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 60_000 });

  const before = await page.getByTestId('chat-turn-evaluator').count();
  await page.getByTestId('chat-text').fill(
    'Entropy is the average surprise of a distribution: how many yes/no questions you ' +
      'need on average to pin down which outcome happened.',
  );
  await page.getByTestId('confidence-4').click();
  await page.getByTestId('chat-send').click();

  // The failure this spec exists for: the turn comes back as the silent-evaluator error
  // rather than as a reply. WHY it is settled in two steps: a poll that waits for
  // 'replied' keeps retrying an error that will never become one, so a regression here
  // would burn the whole budget before reporting. The wait ends the moment the turn
  // settles either way, and the assertion after it names which way it went.
  await expect
    .poll(
      async () => {
        if ((await page.getByTestId('chat-composer-error').count()) > 0) return 'error';
        if ((await page.getByTestId('chat-error').count()) > 0) return 'error';
        return (await page.getByTestId('chat-turn-evaluator').count()) > before ? 'replied' : 'waiting';
      },
      { timeout: 5 * 60 * 1000, intervals: [2_000] },
    )
    .not.toBe('waiting');
  const failure = page.getByTestId('chat-composer-error').or(page.getByTestId('chat-error'));
  expect(
    (await failure.count()) > 0 ? await failure.first().textContent() : null,
    'the turn came back as an error instead of a reply',
  ).toBeNull();

  const reply = page.getByTestId('chat-turn-evaluator').last();
  await expect(reply).toBeVisible();
  expect((await reply.textContent())?.trim().length ?? 0, 'the tutor said something').toBeGreaterThan(20);
  await expect(page.getByTestId('eval-outcome')).toBeVisible();
});
