// FRACTAL: covers project | type e2e | scope delivery-walkthrough
/**
 * Phase-10 delivery walkthrough capture.
 *
 * WHY the specs are not duplicated: the walkthrough does not invent flows — the shipped E2E
 * specs ARE the flows. Rather than fork twelve specs into a parallel tree that would rot the
 * moment one of them changed, this module hangs off the harness the specs already use, and
 * the same `npx playwright test` run doubles as the walkthrough when FRACTAL_WALKTHROUGH=1.
 * Off, every function here is a no-op and costs one boolean per navigation.
 */
import { test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export const WALKTHROUGH_ON = process.env.FRACTAL_WALKTHROUGH === '1';
const RUN_ID = process.env.FRACTAL_RUN_ID ?? `${Date.now()}`;
const ROOT = path.resolve('.fractal/delivery/walkthrough');

type Shot = { step: number; state: string; title: string; png: string };
const shots = new Map<string, Shot[]>();

function flowSlug(file: string): string {
  return path.basename(file).replace(/\.spec\.ts$/, '');
}

const STYLE_PROPS = [
  'display',
  'flexDirection',
  'gap',
  'padding',
  'margin',
  'maxWidth',
  'fontFamily',
  'fontSize',
  'lineHeight',
  'color',
  'backgroundColor',
];

/** Capture one meaningful state of the flow. Monotonic per spec file, so critics read an order. */
export async function shot(page: Page, state: string): Promise<void> {
  if (!WALKTHROUGH_ON) return;
  const info = test.info();
  const flow = flowSlug(info.file);
  const dir = path.join(ROOT, flow);
  fs.mkdirSync(dir, { recursive: true });

  const list = shots.get(flow) ?? [];
  const step = list.length + 1;
  const slug = `step-${String(step).padStart(2, '0')}-${state.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  const png = path.join(dir, `${slug}.png`);

  await page.screenshot({ path: png, fullPage: true });
  fs.writeFileSync(path.join(dir, `${slug}.dom.html`), await page.content(), 'utf8');
  const computed = await page.evaluate((props: string[]) => {
    const el = document.querySelector('main') ?? document.body;
    const cs = window.getComputedStyle(el);
    const picked: Record<string, string> = {};
    for (const prop of props) {
      picked[prop] = cs.getPropertyValue(prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
    }
    return { tag: el.tagName, viewport: { w: window.innerWidth, h: window.innerHeight }, picked };
  }, STYLE_PROPS);
  fs.writeFileSync(path.join(dir, `${slug}.styles.json`), JSON.stringify(computed, null, 2), 'utf8');

  list.push({ step, state, title: info.title, png: path.relative(process.cwd(), png) });
  shots.set(flow, list);
  fs.writeFileSync(
    path.join(dir, 'shots.json'),
    JSON.stringify({ run: RUN_ID, flow, shots: list }, null, 2),
    'utf8',
  );
}

export const runId = RUN_ID;
