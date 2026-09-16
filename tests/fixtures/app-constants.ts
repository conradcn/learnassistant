// FRACTAL: covers project | type fixture | scope constants
/**
 * The handful of facts about the shipped app that the smoke and reachability suites
 * assert on: the port it listens on, the line it prints when it is up, and the route
 * Next.js settles on for a page that does not exist.
 *
 * WHY they are literals here rather than read from the fractal build workspace: that
 * workspace is the harness's, not part of the application. Parsing its state file at module
 * scope made `npm test` depend on the harness being present and on key names the
 * harness is free to change — a missing key surfaced as `expect(undefined)` throwing
 * inside chai rather than as a readable failure. These three values change about once
 * in the life of the project; when they do, change them here.
 *
 * Kept as plain, erasable TypeScript so `scripts/docker-smoke.mjs` can import it
 * directly under Node's type stripping.
 */

/** The port start.bat / start.sh / docker-compose publish. */
export const START_PORT: number = 31544;

/** The line the start scripts print once the server is answering. */
export const START_MARKER: string = '[learn-assistant] Open http://localhost:';

/** Where the App Router lands a navigation to a page that does not exist. */
export const NOT_FOUND_ROUTE: string = '/_not-found';
