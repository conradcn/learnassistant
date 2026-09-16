// FRACTAL: covers project | type e2e | scope harness
import { test as base, expect, type Page, type Response } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { shot, WALKTHROUGH_ON } from './walkthrough/fixtures';

const REACH_DIR = path.resolve('e2e/reachability');
const RUN_ID = process.env.FRACTAL_RUN_ID ?? `${Date.now()}`;

fs.mkdirSync(REACH_DIR, { recursive: true });

const logFile = path.join(REACH_DIR, `visited.${RUN_ID}.ndjson`);

function featureIdFor(specFile: string): string {
  try {
    const header = fs.readFileSync(specFile, 'utf8').split('\n')[0] ?? '';
    const m = header.match(/FRACTAL:\s*covers\s+([A-Za-z0-9.,\s]+?)\s*\|/);
    return m ? m[1].split(',')[0].trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function recordVisit(entry: {
  feature: string;
  url: string;
  status: number;
  clientRoute: string;
  spec: string;
}): void {
  fs.appendFileSync(
    logFile,
    `${JSON.stringify({ t: new Date().toISOString(), run: RUN_ID, ...entry })}\n`,
    'utf8',
  );
}

async function settleAndLog(page: Page, response: Response | null, feature: string, spec: string) {
  await page.waitForLoadState('domcontentloaded');
  const clientRoute = await page.evaluate(() => window.location.pathname);
  recordVisit({
    feature,
    url: page.url(),
    status: response?.status() ?? 200,
    clientRoute,
    spec,
  });
  // WHY (phase 10): every navigation is a meaningful state transition, so the delivery
  // walkthrough gets its screenshot from the same place the reachability log gets its row.
  await shot(page, `at${clientRoute.replace(/\//g, '-') || '-home'}`);
}

type Fixtures = {
  /** Navigate to the flow's single entry URL. Every interior page must be reached by clicking. */
  enter: (url?: string) => Promise<void>;
  /** Click a control and record the route change it produces. */
  clickTo: (locatorAction: Promise<unknown>, expectedRoute?: RegExp | string) => Promise<void>;
  runId: string;
};

export const test = base.extend<Fixtures>({
  runId: async ({}, use) => {
    await use(RUN_ID);
  },
  enter: async ({ page }, use, testInfo) => {
    const feature = featureIdFor(testInfo.file);
    await use(async (url = '/') => {
      const response = await page.goto(url);
      await settleAndLog(page, response, feature, path.relative(process.cwd(), testInfo.file));
    });
  },
  clickTo: async ({ page }, use, testInfo) => {
    const feature = featureIdFor(testInfo.file);
    await use(async (action, expectedRoute) => {
      const before = page.url();
      await action;
      if (expectedRoute) await page.waitForURL(expectedRoute, { timeout: 15_000 });
      else await page.waitForFunction((u) => window.location.href !== u, before, { timeout: 15_000 });
      await settleAndLog(page, null, feature, path.relative(process.cwd(), testInfo.file));
    });
  },
});

if (WALKTHROUGH_ON) {
  // The last frame of every flow: whatever the user is looking at when the journey ends.
  base.afterEach(async ({ page }) => {
    await shot(page, 'flow-end');
  });
}

export { expect };
export const runId = RUN_ID;
export const reachabilityLog = logFile;
