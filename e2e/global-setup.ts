// FRACTAL: covers project | type e2e | scope harness
import path from 'node:path';
import fs from 'node:fs';
import { seedDataRoot } from './seed';

/**
 * WHY (harness safety): the seed only ever touches the data root inside this project.
 * A root resolving anywhere else is refused rather than written to.
 */
export default function globalSetup(): void {
  const root = path.resolve(process.env.LA_DATA_ROOT ?? '.e2e-data');
  const project = path.resolve('.');
  if (!root.startsWith(project + path.sep)) {
    throw new Error(`refusing to seed a data root outside the project: ${root}`);
  }
  // WHY (harness safety): `./data` is the SHIPPED default root — the one a learner's own
  // install writes to. It is inside the project, so the containment check above lets it
  // through, and a stray LA_DATA_ROOT=./data (or a reused app server pointed at it) turns
  // `npm run e2e` into a wipe of somebody's real subjects. Named and refused explicitly.
  if (root === path.resolve('data')) {
    throw new Error('refusing to seed the live app data root (./data); unset LA_DATA_ROOT or point it at .e2e-data');
  }
  const reachDir = path.resolve('e2e/reachability');
  fs.rmSync(reachDir, { recursive: true, force: true });
  writeReachabilityManifest(reachDir);
  // WHY: Playwright runs each project in its own worker process, so leaving the run id to
  // `Date.now()` inside the fixture gave the functional and perf projects two separate
  // navigation logs — and the reachability test, which reads only the newest, then saw the
  // perf run's handful of routes and called every other feature unreached. Stamping one id
  // here (the main process, before any worker spawns) makes the whole invocation one run.
  process.env.FRACTAL_RUN_ID = `${Date.now()}`;
  const ids = seedDataRoot(root);
  process.stdout.write(`[e2e] seeded ${root} (${ids.topicA}, ${ids.topicB})\n`);
}

/**
 * WHY the manifest is copied out here: tests/reachability/ui-pages.test.ts grades the
 * navigation log against "which F-IDs declare a UI", and that list lives in the build
 * harness's workspace (`.fractal/state.json`). Reading it from `tests/` coupled the
 * whole vitest suite to a harness a clean clone need not have. The Playwright harness
 * owns that workspace, so it writes the slice the test needs beside the log it grades —
 * and the test then reads nothing but its own run artifacts.
 */
function writeReachabilityManifest(reachDir: string): void {
  const statePath = path.resolve('.fractal', 'state.json');
  if (!fs.existsSync(statePath)) return;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
    features?: Record<string, { title: string; requiresE2E?: boolean; uiRoutes?: string[] }>;
  };
  const expected = Object.entries(state.features ?? {})
    .filter(([, f]) => f.requiresE2E)
    .map(([fid, f]) => ({ fid, title: f.title, uiRoutes: f.uiRoutes ?? [] }));
  fs.mkdirSync(reachDir, { recursive: true });
  fs.writeFileSync(path.join(reachDir, 'expected.json'), JSON.stringify(expected, null, 2) + '\n');
}
