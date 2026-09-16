// FRACTAL: covers project | type e2e | scope harness
// Phase-9 UI refinement capture: one screenshot + DOM + computed styles per (F-ID x viewport).
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { readSeed, A_OPEN_1 } from '../seed';

const ITER = process.env.FRACTAL_UI_ITER ?? '1';
const OUT = path.resolve('.fractal/ui-history', `iter-${ITER}`);

const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

function views() {
  const { topicA } = readSeed();
  return [
    { id: 'F5', route: '/' },
    { id: 'F1', route: '/topics/new' },
    { id: 'F2', route: `/topics/${topicA}` },
    { id: 'F3', route: `/modules/${A_OPEN_1}` },
    { id: 'F4', route: `/modules/${A_OPEN_1}/eval` },
    { id: 'F7', route: '/review' },
    { id: 'F8', route: '/practice' },
    { id: 'F9', route: '/synthesis' },
    { id: 'F11', route: '/journal' },
    { id: 'F13', route: `/topics/${topicA}/capstone` },
    { id: 'X-settings', route: '/settings' },
    { id: 'X-recover', route: '/recover' },
  ];
}

async function styles(page: Page) {
  return page.evaluate(() => {
    const props = ['font-family','font-size','font-weight','line-height','color','background-color','padding','margin','gap','border','display','position','width','height','max-width','overflow'];
    const pick = (el: Element) => {
      const cs = getComputedStyle(el);
      const o: Record<string, string> = {};
      for (const p of props) o[p] = cs.getPropertyValue(p);
      return o;
    };
    const out: Record<string, unknown> = {};
    out['body'] = pick(document.body);
    const main = document.querySelector('main');
    if (main) out['main'] = pick(main);
    for (const el of Array.from(document.querySelectorAll('[data-testid]')).slice(0, 60)) {
      out[`[data-testid="${el.getAttribute('data-testid')}"]`] = pick(el);
    }
    return out;
  });
}

test.describe.configure({ mode: 'serial' });

for (const view of views()) {
  for (const vp of VIEWPORTS) {
    test(`capture ${view.id} ${vp.name}`, async ({ page }) => {
      fs.mkdirSync(OUT, { recursive: true });
      const errors: string[] = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const res = await page.goto(view.route, { waitUntil: 'networkidle' });
      const status = res?.status() ?? 0;
      const base = path.join(OUT, `${view.id}.${vp.name}`);
      await page.screenshot({ path: `${base}.png`, fullPage: true });
      fs.writeFileSync(`${base}.dom.html`, await page.content(), 'utf8');
      fs.writeFileSync(`${base}.styles.json`, JSON.stringify(await styles(page), null, 2), 'utf8');
      fs.appendFileSync(
        path.join(OUT, 'capture.ndjson'),
        `${JSON.stringify({ feature: view.id, viewport: vp.name, route: view.route, status, consoleErrors: errors })}\n`,
        'utf8',
      );
      expect(status, `${view.route} returned ${status}`).toBeLessThan(400);
    });
  }
}
