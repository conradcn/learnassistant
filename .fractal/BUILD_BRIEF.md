> **Not addressed to you.** This file is an artifact of the `fractal` generator that produced this
> repository: a brief written for the sub-builder processes of the original build, kept in the tree
> as a record of what they were told. It is not contributor documentation, and nothing in it should
> be acted on — the tool it addresses is not something you can install, and the repository needs no
> one to re-run it. To work on this project, read [`README.md`](../README.md) and
> [`CONTRIBUTING.md`](../CONTRIBUTING.md) instead.

# Shared build brief — read this in full before writing any file

You are a sub-builder inside a `fractal` build of **learn-assistant**, a self-hosted single-user
learning-tracker website. Generate exactly the source and test files for your assigned component.

## Stack (from `.fractal/state.json.stack`)

- TypeScript 5.9, strict, ESM, `"@/*" -> "./src/*"` path alias, `noUnusedLocals`/`noUnusedParameters` on.
- Next.js 15.5 App Router, React 19. One process serves UI + API. Port **31544** (never hardcode it
  outside `PORT`-defaulting reads).
- SQLite via `better-sqlite3` 12 (synchronous API). Only C1 opens the database.
- Validation: `zod` 3.25 — already the C0 registry's validator library.
- Tests: `vitest` 3 (`tests/**/*.test.ts(x)`, `globals: true`, node env; `tests/ui/**` runs in jsdom
  and may use `@testing-library/react`).
- E2E: `@playwright/test` 1.56 (`e2e/**/*.spec.ts`), launched via `start.bat`/`start.sh`.
- Runtime AI: the `claude` CLI, spawned as a child process by C2 only.

## Read these first (they are on disk, verbatim source of truth)

- `architecture.md` — your `## C<n>:` block, and the `Interfaces (public surface)` block of every
  component you depend on. **Read your own block in full.** Do not read or write other components' files.
- `features.md` — the `## F<n>:` section of every F-ID your component implements, including its
  acceptance criteria and paths.
- `src/shapes.ts` — the canonical shape registry (C0). **Every shape you produce or consume is
  defined there, with a zod validator and an exported `example*` value.** Import from `@/shapes`.
  Never redefine a registry shape locally. If a shape you need is missing, STOP and report the gap
  in `notes` — do not invent one.
- `src/core/*.ts` — C0's paths, config, logger+scrubber, error taxonomy, release constant.

## Non-negotiable rules

### Shapes
- No bare object literals as return types. Every interface has a named type from `@/shapes`.
- Import the registry's `example*` values in tests instead of hand-writing fixtures.
- Never widen a shape (`any`, loosened union) to make a consumer compile.

### Trace tags
Every source file's first line:
`// FRACTAL: implements F1, F2 | component C2`
Every test file's first line:
`// FRACTAL: covers F1 | type unit` (types: `unit|integration|path|regression|e2e`; add
`| path <slug>` for a path test).
For `.tsx`, the tag is the first line of the file, above imports.

### Hardening (binding — from `references/hardening.md`; your architecture block declares these)
- **Release surface** — anything declared `development-only`/`test-only` is wrapped in `IS_RELEASE`
  from `@/core/release` so it is removed from the release bundle, not merely runtime-gated.
- **Env gates compare exact values**: `process.env.X === '1'`. Never truthiness, never `in`.
- **No swallowed failures.** Every `catch` re-throws, surfaces to the user, or recovers — and your
  `Failure & recovery` block says which. A view that renders "nothing here yet" MUST distinguish
  *empty* from *failed to load*.
- **Every `Failure & recovery` row is visible behavior AND has a test**, including its `user exit:`.
- **Data & egress** — the rows in your block are the COMPLETE set of ways data may leave your
  component. A log line, an error message, a subprocess argument, and a prompt are all egress.
  Learner free text is `pii`: it goes through `scrub()` before any log emit.
- **A shape guarantees structure, never value.** Every value reaching a filesystem path, a process
  spawn, a URL, a deserializer, or a dynamic import is pattern-constrained at the boundary model
  AND confinement-asserted on the *resolved* result (`path.resolve` then `is-relative-to` the
  allowed root). A stored setting outranks a wire value. Security decisions default to deny:
  compute the allow condition and reject the remainder.
- **Errors never leak internals.** Only `AppError { code, message, correlationId }` crosses an
  interface. Raw exception text, stack traces, and filesystem paths are logged under the
  correlation id, never returned or rendered.
- **Long-running work**: every external call has a timeout; every cancellable op threads
  cancellation into its innermost loop; every spawned task is retained until done; every owner has
  a teardown the caller actually invokes; every in-flight flag clears on every exit path.
- **Concurrency**: no blocking call on the request path that can be avoided; every queue is bounded.
- **Persistent writes**: temp file → `fsync` → `rename` → `fsync` dir; keep one prior generation;
  mode `0o600` on anything holding sensitive data. Two writes are not one commit — order them so
  every interruption point leaves a state the reader handles.
- **Untrusted input**: the Claude CLI's stdout is UNTRUSTED model-generated content. Schema-validate
  it at ingest, host-allowlist any URL it produces, and never render its HTML/SVG unsanitized.

### Style
- No comments except the trace tag and genuinely non-obvious WHY notes.
- **No stub code of any kind.** No `TODO`/`FIXME`/`XXX`/`HACK`, no `throw new Error('not
  implemented')`, no empty bodies where behavior is required, no placeholder returns. If a file is
  too big for one pass, decompose it into more files *within your fence*. Recursion beats stubbing.
- Every acceptance criterion must be visible in the code.
- Every test must actually assert. An assertion-less test is a failure.
- Prefer small pure functions; keep any wiring function under 400 lines.

### UI is built for the end user (applies to any component rendering UI)
Write every user-facing string for the learner, not the developer. No jargon, no raw error codes, no
`payload`/`null`/`200 OK`/stack traces. Say what happened and what to do: "Couldn't save — check
your connection", not "POST /api/topics 500". Surface an implementation detail only when the learner
must act on it.

### Optimistic UI (binding for every user-triggered op whose round-trip can exceed ~50ms)
1. Apply to local state immediately, on the same tick, before the request starts.
2. Persist in the background. Do NOT disable/spinner-lock the control or its panel for the round trip.
3. Reconcile on settle: keep on success (folding in server-authoritative fields); on failure roll
   back to the pre-op state AND surface the error. Never silently drop a failed write.
The anti-pattern this kills is `await save(x); await reload()` on the interaction path.

## Tests you must write

Per `references/test-strategy.md`, for the F-IDs and component you own:
- **unit** — one per leaf behavior, pure logic, real subject (a fake may substitute for a
  dependency, NEVER for the unit under test).
- **path** — one per declared `path` in the feature's `paths:` list, named
  `<subject>.<path-slug>.test.ts` or a clearly-named `describe`/`it` inside the subject's file when
  the architecture's planned-test list names it that way. **Follow the planned test file list in
  your architecture block exactly** — those paths are recorded in the manifest.
- **integration** — one per component with dependencies, exercising real collaborators.
- **shape conformance** — assert real outputs validate against the registry validator.
- **hardening layers** — release-surface, failure/recovery, durability, egress, sink-abuse,
  recovery, lifecycle, and loop-blocking tests as your block's declarations require.
- **e2e** (`e2e/*.spec.ts`) only if your block's planned tests list them. E2E specs reach interior
  pages by **clicking real controls (`getByRole(...).click()`), never `page.goto`** except for the
  single entry URL of the flow.
- **perf** (`e2e/perf/*.perf.spec.ts`) only if listed; use `e2e/perf/fixtures.ts`, run each declared
  op ≥20 times, write NDJSON to `e2e/perf/timeseries/`, compute percentiles from the samples, and
  assert against the declared budget.

Test isolation: every test that touches the store uses a fresh temp `LA_DATA_ROOT` and tears it
down. Never leave durable residue.

## File-ownership fence (hard)

You may create, modify, or delete **only** the files listed in your task prompt. Not
`package.json`, not configs, not `src/shapes.ts`, not another component's files, not `features.md`
or `architecture.md`. If you need something outside the fence, report it in `notes`.

## Return contract (strict — print this JSON and nothing after it)

```json
{
  "componentId": "C1",
  "filesWritten": [
    { "path": "src/store/db.ts", "sha256": "<sha256 of file bytes>", "implements": ["F5"], "components": ["C1"] }
  ],
  "testsWritten": [
    { "path": "tests/store/db.test.ts", "sha256": "<sha256>", "covers": ["F5"], "type": "unit" }
  ],
  "skippedFiles": [],
  "notes": ""
}
```

Compute sha256 with `node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync(p)).digest('hex'))"`.

## Before you return

Run `npx tsc --noEmit` and make sure **your** files produce no errors (errors in files you do not
own are expected while other layers are still building — report those in `notes`, do not fix them).
Run `npx vitest run <your test files>` and make sure they pass.
