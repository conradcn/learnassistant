// FRACTAL: covers F3 | type e2e
/**
 * Wide display maths stays inside its own box.
 *
 * WHY: an aligned equation can be wider than the 940px content column. Without an
 * overflow rule it widens the document itself, and the browser then scrolls the whole
 * page sideways — nav, cards and all — every time the learner drags the equation.
 */
import { test, expect } from './fixtures';
import { pastWarmUp } from './helpers';
import { SUBJECT_A, WIDE_MATH_LESSON } from './seed';

test('a display equation wider than the column scrolls itself, not the page', async ({
  page,
  enter,
  clickTo,
}) => {
  // WHY here: KaTeX positions every glyph with an inline `style` attribute, and style-src
  // governs style attributes — so this lesson page is the sharpest test that the document
  // CSP set in middleware.ts does not silently break the maths. This spec already opens a
  // KaTeX-heavy lesson, so the check rides along rather than mutating the shared seed twice.
  const cspViolations: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { __csp?: string[] }).__csp ??= [];
      (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} blocked ${e.blockedURI}`);
    });
  });

  await enter('/');
  await clickTo(page.getByRole('link', { name: SUBJECT_A }).click(), /\/topics\/t_[A-Za-z0-9]{16}$/);
  await clickTo(
    page
      .getByTestId('graph-open-node')
      .filter({ hasText: WIDE_MATH_LESSON })
      .getByTestId('open-module')
      .click(),
    /\/modules\/m_[A-Za-z0-9]{16}$/,
  );
  await pastWarmUp(page);

  const equation = page.locator('.katex-display').first();
  await expect(equation).toBeVisible();

  // The equation really is wider than the column, or this test proves nothing.
  const box = await equation.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowX: getComputedStyle(el).overflowX,
  }));
  expect(box.scrollWidth).toBeGreaterThan(box.clientWidth);
  expect(box.overflowX).toBe('auto');

  // ...and the page itself did not grow with it.
  const doc = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(doc.scrollWidth).toBe(doc.clientWidth);

  // Nothing is clipped vertically: the box is tall enough for the baseline and the
  // superscripts KaTeX draws outside its line box.
  expect(box.scrollHeight).toBeLessThanOrEqual(box.clientHeight);

  // A keyboard-only learner can reach the scroller and move it.
  await expect(equation).toHaveAttribute('tabindex', '0');
  await equation.focus();
  await expect(equation).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(async () => equation.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
  // Scrolling the equation left the page where it was.
  expect(await page.evaluate(() => window.scrollX)).toBe(0);

  cspViolations.push(...(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])));
  expect(cspViolations, cspViolations.join('; ')).toEqual([]);
});
