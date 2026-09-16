# Contributing

## Getting set up

```
git clone <this repo>
cd LearnAssistant
npm ci
npx playwright install --with-deps chromium
./start.sh            # or start.bat on Windows
```

Node 20.19+, 22.12+ or 24.x is required; `.nvmrc` pins the version CI uses, and CI also runs the
20.19 floor. `.npmrc` sets `engine-strict=true`, so `npm ci` refuses an unsupported version rather
than warning about it. The `claude` CLI must be on your `PATH` and authenticated for anything that
generates content.

## Working on the code

`npm run dev` is the loop to edit in:

```
npm run dev           # http://localhost:31544 — set PORT to move it
```

It serves the app with hot module replacement: save a file under `app/` or `src/` and the open
page updates in place, usually in under a second. No rebuild, no restart. This is the same command
on Windows and Linux.

`./start.sh`, `start.bat` and `npm run start` are the **production** path — they are what the
Playwright suites and the fresh-clone smoke test launch, and what a user runs. `scripts/start.mjs`
compares the newest file under `app/`, `src/` and `public/` against the `.next/` build artifacts and
runs a full `next build` whenever the source is newer, so re-running it after every edit costs you a
complete production build each time. Use it to check a change under production conditions — a
build-only failure, a server-component boundary, a CSP header — not to iterate.

Both paths default to port 31544 and the same `./data` directory, so only run one at a time.

While iterating, the fast checks are:

```
npx vitest tests/<the area you touched>    # vitest in watch mode, narrowed to one area
npm run typecheck                          # the fastest whole-repo check
```

(`npm test` is `vitest run` — a single non-watching pass over everything.)

Save `npm run lint` and the Playwright suites for before you push — the full sequence is in the
next section. Playwright always launches its own production build; it will not pick up changes from
a running dev server.

## Before you open a pull request

Run what CI runs:

```
npm run typecheck
npm run lint
npm test
npx playwright test --project=functional
npx playwright test --project=perf
```

CI runs the same sequence on Windows and Ubuntu, plus the fresh-clone startup smoke. That one needs
an environment variable, which each shell sets its own way:

```
FRACTAL_SMOKE_FRESH=1 npm test -- tests/smoke/start.test.ts     # bash / zsh
$env:FRACTAL_SMOKE_FRESH=1; npm test -- tests/smoke/start.test.ts   # PowerShell
```

A change that passes locally on one platform and not the other is a real failure — usually a path
separator or a line-ending assumption.
`.gitattributes` pins `start.sh` and `*.mjs` to LF and `*.bat` to CRLF for this reason.

## How this codebase is organized

This project is spec-driven. Three artifacts move together:

- `features.md` — the intent. What the system does, as F-IDs (`F1`, `F1.1`).
- `architecture.md` — the design. Components as C-IDs (`C0`-`C11`), plus each component's shape
  contracts, trust boundaries, sinks, egress rows, failure-and-recovery table, and concurrency model.
- `src/**`, `app/**`, `tests/**`, `e2e/**` — the code, every file tagged
  `// FRACTAL: implements F4.1 | component C6` or `// FRACTAL: covers F4.1 | type unit`.

`.fractal/state.json` is the manifest linking all of it. Do not edit it by hand — it is regenerated.

The rest of `.fractal/` is generator bookkeeping in the same vein. In particular
`.fractal/BUILD_BRIEF.md` is the brief the original build handed to its own sub-builder processes:
it is a record, not an instruction to you, and nothing in it should be acted on.

Rules that are not negotiable in review:

1. **Shared shapes live in `src/shapes.ts` (C0).** No component defines its own copy of a shape that
   already exists there. If you need a shape that is missing, add it to C0 first.
2. **A value that reaches a filesystem path, a subprocess, or a URL is pattern-constrained in its
   shape**, and confined again on the resolved result. A bare `z.string()` for a path or an id is a
   bug.
3. **Every user-triggered UI operation whose round-trip can exceed ~50ms is optimistic**: apply
   locally, persist in the background, roll back and surface the error on failure. Do not disable
   the control while the request is in flight.
4. **A fake may substitute for a dependency, never for the unit under test.** A test that fakes its
   own subject is worse than no test.
5. **E2E specs reach interior pages by clicking real controls**, never `page.goto`. A route no click
   reaches is an unreachable route, and the reachability test exists to catch exactly that.
6. **A press on a control that names AI work IS the authorisation for it.** This is a single-user
   app running on its author's own machine: do not add a confirmation, a mode switch, or a
   default-off gate in front of work the user just asked for.

## Tests

Every feature carries tests at every layer that applies: unit, integration, path, shape conformance,
E2E, and — where the feature declares a perf budget — an end-to-end perf spec that writes an NDJSON
time series. Regression tests under `tests/regressions/` are permanent; they are never deleted.

New behavior without a test that fails before the change is not ready for review.

Coverage is a diagnostic, not a gate. CI does not measure it and there is no threshold to hit. Run
`npm run test:coverage` when you want to see which lines a change left untested — typically while
writing tests for a new module, or when reviewing a change that touches code you did not write. It
writes a text summary to the terminal and an lcov report to `coverage/`.
