// FRACTAL: covers project | type perf | scope harness
import { test as base, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { recordVisit } from '../fixtures';

const TS_DIR = path.resolve('e2e/perf/timeseries');
export const RUN_ID = process.env.FRACTAL_RUN_ID ?? `${Date.now()}`;

fs.mkdirSync(TS_DIR, { recursive: true });

export type Sample = {
  t: string;
  run: string;
  feature: string;
  op: string;
  durMs: number;
  ok: boolean;
  meta: Record<string, unknown>;
};

function fileFor(feature: string): string {
  return path.join(TS_DIR, `${feature.toLowerCase()}.${RUN_ID}.ndjson`);
}

/** The only writer of timeseries files. Specs emit events through `measure`. */
export function emit(sample: Sample): void {
  fs.appendFileSync(fileFor(sample.feature), `${JSON.stringify(sample)}\n`, 'utf8');
}

export async function measure<T>(
  feature: string,
  op: string,
  fn: () => Promise<T>,
  meta: Record<string, unknown> = {},
): Promise<T> {
  const started = performance.now();
  let ok = true;
  try {
    return await fn();
  } catch (e) {
    ok = false;
    throw e;
  } finally {
    emit({
      t: new Date().toISOString(),
      run: RUN_ID,
      feature,
      op,
      durMs: performance.now() - started,
      ok,
      meta,
    });
  }
}

export function readSamples(feature: string, op: string): Sample[] {
  const file = fileFor(feature);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Sample)
    .filter((s) => s.op === op && s.run === RUN_ID);
}

/**
 * Measures a UI interaction *inside the page* rather than across the Playwright wire.
 *
 * WHY this exists: `measure` clocks a Node-side function whose every step is a CDP
 * round-trip, so a 10ms interaction records as ~150ms of harness overhead — the budget
 * then describes the test runner and can never be met by making the app faster. Here the
 * clock starts and stops in the browser, around a real click and the real DOM mutation
 * the learner is waiting for, so the number is the UI overhead the budget is written
 * about. Measured in the page, this same F1 submit is ~10ms against the ~150ms the
 * wire-level timing reported.
 */
export async function measureInPage(
  page: Page,
  feature: string,
  op: string,
  spec: { trigger: string; until: string; nth?: number },
  meta: Record<string, unknown> = {},
): Promise<void> {
  let ok = true;
  let durMs = Number.NaN;
  try {
    durMs = await page.evaluate(
      ({ trigger, until, nth }) =>
        new Promise<number>((resolve, reject) => {
          // A bare testid is the common case; a trigger that already contains `[` is
          // taken as a full selector, so a spec can scope to "the open ones" and not just
          // "everything wearing that testid".
          const selector = trigger.includes('[') ? trigger : `[data-testid="${trigger}"]`;
          const targets = document.querySelectorAll(selector);
          const target = targets[nth ?? 0] ?? null;
          if (target === null) {
            reject(new Error(`no control matching "${trigger}" at index ${nth ?? 0}`));
            return;
          }
          const done = (): boolean => document.querySelector(`[data-testid="${until}"]`) !== null;
          const started = performance.now();
          const settle = (): void => {
            observer.disconnect();
            clearTimeout(bail);
            resolve(performance.now() - started);
          };
          const observer = new MutationObserver(() => {
            if (done()) settle();
          });
          const bail = setTimeout(() => {
            observer.disconnect();
            reject(new Error(`"${until}" never appeared after clicking "${trigger}"`));
          }, 30_000);
          observer.observe(document.body, { childList: true, subtree: true, attributes: true });
          (target as HTMLElement).click();
          if (done()) settle();
        }),
      { trigger: spec.trigger, until: spec.until, nth: spec.nth ?? 0 },
    );
  } catch (e) {
    ok = false;
    throw e;
  } finally {
    emit({ t: new Date().toISOString(), run: RUN_ID, feature, op, durMs, ok, meta });
  }
}

/**
 * Installs a probe that records, in every document this page loads, the moment a given
 * testid first exists — on the destination document's own clock, whose origin is that
 * navigation's start.
 *
 * WHY this exists alongside `measureInPage`: opening a lesson is a real document
 * navigation, so a `page.evaluate` started before the click dies with the old execution
 * context, and a Node-side clock around click + poll bills two CDP round-trips to the
 * app. Navigation start → "the thing the learner came for is in the DOM" is the wait the
 * budget is written about, and only the destination document can time it.
 */
export async function installNavigationProbe(page: Page, until: string): Promise<void> {
  await page.addInitScript((testid: string) => {
    const w = window as unknown as { __laSeenAt?: number };
    const selector = `[data-testid="${testid}"]`;
    const check = (): boolean => {
      if (document.querySelector(selector) === null) return false;
      if (w.__laSeenAt === undefined) w.__laSeenAt = performance.now();
      return true;
    };
    const start = (): void => {
      if (check()) return;
      const observer = new MutationObserver(() => {
        if (check()) observer.disconnect();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.documentElement !== null) start();
    else document.addEventListener('readystatechange', start, { once: true });
  }, until);
}

/** Clicks something that navigates, and records the destination's navigation-start → `until`. */
export async function measureNavigation(
  page: Page,
  feature: string,
  op: string,
  spec: { click: () => Promise<void>; until: string },
  meta: Record<string, unknown> = {},
): Promise<void> {
  let ok = true;
  let durMs = Number.NaN;
  try {
    await spec.click();
    await page.waitForFunction(
      () => (window as unknown as { __laSeenAt?: number }).__laSeenAt !== undefined,
      undefined,
      { timeout: 30_000 },
    );
    durMs = await page.evaluate(
      () => (window as unknown as { __laSeenAt: number }).__laSeenAt,
    );
  } catch (e) {
    ok = false;
    throw e;
  } finally {
    emit({ t: new Date().toISOString(), run: RUN_ID, feature, op, durMs, ok, meta });
  }
}

/** Samples that must sit strictly above the asserted percentile for it to be one. */
const MIN_SAMPLES_ABOVE = 2;

export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/**
 * Asserts a declared budget and every reasonable-delay rule: hard breach, tail blowout, and
 * no-samples. A breach message is written so `/fractal bug` can quote it verbatim.
 */
export function assertBudget(
  feature: string,
  op: string,
  budgetMs: number,
  p: number,
): { p50: number; p95: number; p99: number; n: number } {
  const durations = readSamples(feature, op)
    .filter((s) => s.meta.warmup !== true)
    .map((s) => s.durMs);

  if (durations.length === 0) {
    throw new Error(`PERF NO SAMPLES ${feature} ${op}: the harness recorded zero non-warmup samples`);
  }

  // WHY (H8): `ceil(p/100 * n) - 1` lands on the last index whenever fewer than
  // 1/(1-p/100) samples were taken, so a "p95" over 12 samples IS the maximum. That check
  // cannot distinguish a regression from one scheduler stall — it failed this suite on
  // three different specs across three consecutive green-app runs. A percentile is only
  // asserted once enough samples sit above it for the tail to mean something.
  const minSamples = Math.ceil(MIN_SAMPLES_ABOVE / (1 - p / 100));
  if (durations.length < minSamples) {
    throw new Error(
      `PERF UNDERSAMPLED ${feature} ${op}: p${p} needs at least ${minSamples} samples to be a percentile rather than the maximum, got ${durations.length}`,
    );
  }

  const stats = {
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
    n: durations.length,
  };
  const measured = percentile(durations, p);
  const line = `p${p}=${measured.toFixed(0)}ms (budget ${budgetMs}ms, n=${stats.n}, p50=${stats.p50.toFixed(0)}ms, p99=${stats.p99.toFixed(0)}ms)`;

  if (measured >= budgetMs) throw new Error(`PERF BREACH ${feature} ${op}: ${line}`);
  if (stats.p99 > 4 * stats.p95 && stats.p95 > 5) {
    throw new Error(`PERF TAIL BLOWOUT ${feature} ${op}: ${line}`);
  }
  return stats;
}

export const test = base.extend<{ enterPerf: (url?: string) => Promise<void> }>({
  enterPerf: async ({ page }, use, testInfo) => {
    await use(async (url = '/') => {
      const response = await page.goto(url);
      const clientRoute = await page.evaluate(() => window.location.pathname);
      recordVisit({
        feature: (testInfo.file.match(/f(\d+)-/i)?.[0] ?? 'unknown').replace('-', '').toUpperCase(),
        url: page.url(),
        status: response?.status() ?? 200,
        clientRoute,
        spec: path.relative(process.cwd(), testInfo.file),
      });
    });
  },
});

export { expect };
export const runId = RUN_ID;
