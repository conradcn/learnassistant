# Troubleshooting

## It will not start

**`start.sh` / `start.bat` exits immediately.** Run it from a terminal rather than by
double-clicking, so you can read the error. The script installs dependencies when `node_modules/` is
missing and builds when `.next/BUILD_ID` is missing; both steps print what they are doing.

**`EADDRINUSE` on port 31544.** Something is already listening — often a previous run of this app
that did not shut down. Stop it, or start on another port:

```
PORT=31600 ./start.sh          # Linux / macOS / Git Bash
set PORT=31600 && start.bat    # Windows cmd
```

On Windows: `netstat -ano | findstr 31544`, then `taskkill /PID <pid> /F`.

**Node version errors.** `package.json` requires Node 20.19+, 22.12+ or 24.x, and `.nvmrc` pins 24.
Because `.npmrc` sets `engine-strict=true`, `npm ci` fails outright on anything else with an
`EBADENGINE` error naming the version it wanted. Check with `node -v`; `nvm use` if you have nvm.
The bounds are not arbitrary: below 20.19 `pdfjs-dist` calls `Promise.withResolvers()`, which does
not exist there, so PDF curriculum sources throw; from 25 up `better-sqlite3` has no prebuild.

**The install stops in a compiler, not in this app.** A failure whose stack trace names `node-gyp`,
`gyp ERR!`, Python, or Visual Studio — and mentions neither SQLite nor LearnAssistant — is
`better-sqlite3` being built from source. It ships prebuilt binaries, but only for the Node versions
it was published against: **20, 22, 23 and 24**. On Node 21, 25 or 26 there is no prebuild to
download, so the install falls back to compiling, and without a C++ toolchain that fallback fails.

Switch to a Node version that has one — `.nvmrc` pins 24, so `nvm use` in this directory is usually
the whole fix. Otherwise use `docker compose up` (see the README), which needs no Node and no
toolchain at all; the image brings its own compiler.

**The build fails after a `git pull`.** Delete `.next/` and start again — the start script rebuilds
when the build output is missing.

## Nothing generates

Pressing a button that names AI work starts that work — there is nothing to switch on first. If a
press does nothing:

- **Is the `claude` CLI installed and authenticated?** Run `claude --version`. If the binary is
  somewhere unusual, set `LA_CLAUDE_BIN` to its full path.
- **Is a different provider selected?** The Settings page names which model does the work and shows
  whether it is answering; a provider that is not reachable says so there.
- **Is the work simply queued?** Sessions run a few at a time (`LA_SESSION_CONCURRENCY`), so a
  subject that fans out into many lessons finishes them in batches rather than all at once.

## Generation started and then stalled

Curriculum generation is 8-15 `claude` sessions and is genuinely slow — the declared budget allows
up to 20 minutes for a full topic. Progress is reported per module. A session that exceeds its
timeout is recorded as retryable rather than as a permanent failure; retry it from the topic page.

To halt a run that is under way, stop the app. Work already spent is not refundable.

## "The app is reachable on a different port than it is configured for"

Every page loads, the server is healthy, and yet every action fails with:

> The app is reachable on a different port than it is configured for. Publish or proxy it on the
> same port the app runs on — see docs/TROUBLESHOOTING.md.

The app only answers requests whose `Host` header is `localhost`, `127.0.0.1` or `[::1]` **on its
own port** — the port in `PORT` (31544 by default). If you reach it on a different port, the `Host`
header carries that other port and the request is refused before it reaches anything.

The two ways this happens:

- **A container published on another port.** `docker run -p 8080:31544` — or a `ports:` entry in
  `docker-compose.yml` with different numbers on either side — makes every request arrive with
  `Host: localhost:8080`. Publish the same number on both sides (`-p 31544:31544`), or set `PORT`
  to the port you publish on so the app and the outside agree.
- **A reverse proxy in front of the app.** nginx, Caddy or a tunnel that forwards to 31544 while
  listening on 80, 443 or anything else sends its own `Host` through. Either drop the proxy, or
  configure it to pass the app's own `host:port` (nginx: `proxy_set_header Host localhost:31544;`).

The server log names the mismatch exactly: look for the `api.host_rejected` event in
`<dataRoot>/logs/app-*.ndjson`, which records the `Host` that arrived and the hosts that are
accepted.

## "Your saved learning couldn't be opened"

The app could not read `learn.db`. It sends you to `/recover`, which offers to put the previous copy
of that file back — you may lose the last few minutes of work and nothing else. If there is no
previous copy, the page offers to start again with an empty set.

## I want to start over

Stop the app and delete the data directory (`./data`, or whatever `LA_DATA_ROOT` points at). It
holds `learn.db`, the authored module directories under `topics/`, and the logs under `logs/`.
Deleting it returns the app to a first run. Nothing under `data/` is tracked by git.

## Tests

**Playwright says no browser is installed.** Run `npx playwright install --with-deps chromium`.

**A Playwright run attaches to an app you did not start.** The config reuses an existing server on
the configured port. Stop any stray listener on 31544 before running the suites, or the tests will
silently exercise the old build.

**The fresh-clone smoke test fails but everything else passes.** It clones the committed tree, so it
only sees files git tracks. An untracked file that the build needs is the usual cause — check
`git status --porcelain`.
