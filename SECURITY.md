# Security

## Reporting a vulnerability

Report privately, not in a public issue. Open a
[GitHub private security advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, or email the maintainer at the address on the commits in this repository.

Please include what you did, what happened, and what you expected. Expect an acknowledgement within
a week. There is no bounty program.

This project is maintained by one person in their own time, so triage is best effort: expect an
initial reply rather than a fix within that week, and expect fixes to land on `main` without a
coordinated release. Please give the maintainer 90 days before disclosing publicly.

## Threat model, briefly

learn-assistant is a single-user, self-hosted application. What it binds to depends on how you
launch it, and none of the launch paths restrict the listener to loopback for you:

- `npm start` (`scripts/start.mjs:117`) and `npm run dev` (`scripts/dev.mjs:19`) run `next` with
  `-p <port>` and no `-H`, so the listener uses Next's own default host.
- The Docker image (`docker/entrypoint.sh:42`) runs
  `next start -p "$PORT" -H "${LA_BIND_HOST:-0.0.0.0}"`, which listens on **all interfaces** unless
  you say otherwise. That default is deliberate: a container that bound to `127.0.0.1` would only be
  reachable from inside itself, so `docker run -p` could never forward to it.

`LA_BIND_HOST` is the control for the container's bind address — set `LA_BIND_HOST=127.0.0.1` only
if you are running the image with host networking, never with published ports. For the host launch
paths, the equivalent control is the port publishing and firewall rules around them, and, under
Docker, binding the published port to a specific host address (`-p 127.0.0.1:31544:31544`) rather
than to `0.0.0.0`.

So the port may be reachable from your network, and the HTTP surface is what actually protects the
application:

- **A per-launch token.** Every API request must carry it in the `x-la-token` header
  (`src/api/auth.ts:81`). It is not a cookie and not an `Authorization` bearer, so a cross-site form
  post or image tag cannot supply it. The token is generated per launch and stored in
  `.session-token`.
- **A `Host` check.** The request's `Host` must be `127.0.0.1`, `localhost` or `[::1]` at the
  configured port (`src/api/auth.ts:17`, `src/api/auth.ts:74`). A browser reaching the app at a LAN
  address or hostname sends that address as `Host` and is refused.
- **An `Origin` / `Sec-Fetch-Site` check.** Cross-site requests are refused before the token is even
  examined (`src/api/auth.ts:78`).

Binding to loopback is not by itself authentication either — any local process, and any page in
your browser, can reach a loopback port — which is why the checks above run regardless of the bind
address.

What you are expected to do on a shared or untrusted network: do not publish the port to
`0.0.0.0`. Publish it to `127.0.0.1` (or to a host-only interface), or keep the port closed at the
firewall, and treat `.session-token` as a secret. The token and header checks are a second line of
defence, not a reason to expose the port.

What is in scope:

- Escaping the module sandbox: a `claude` session is scoped to one module's directory. A path that
  resolves outside it is a vulnerability.
- Command construction for the `claude` subprocess: any input that changes which binary runs or what
  arguments it receives.
- The per-launch token, `Host` and `Origin` checks on the local HTTP API.
- Leaking learner data — answers, reflections, journal entries — to any destination not listed in
  the "What this talks to" table in the README.
- Secrets on disk: `.scrub-salt`, `.session-token`, and `learn.db` are written with restrictive
  modes and are gitignored.

Out of scope: anything that requires an attacker who already has your user account on your machine,
and the security of the Anthropic API or the `claude` CLI itself.

## Supported versions

The `main` branch is the supported version. There is no long-term support branch and no backport
policy.
