# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The post-lesson chat is now one conversation rather than a cold start per turn. Every turn used to
  spawn a fresh Claude CLI process and re-send the whole brief — the lesson, the objectives, the pass
  criteria and the entire transcript — so the wait before the tutor said anything grew with the
  conversation. The first turn now names a CLI conversation and each later turn resumes it, sending
  only what the learner just typed; the model supplies the rest from its own transcript, and the
  fixed preamble is read from cache instead of written again. A resume the CLI cannot honour falls
  back to the full brief in a new conversation, so a dropped transcript costs one slow turn rather
  than the conversation. Derived context the transcript cannot carry — prior capstone rounds — is
  still restated on every turn.
- The evaluation prompt is addressed to the learner rather than to the model. It opened by telling
  the session it was "authoring or evaluating exactly one module", and sessions answered in kind,
  reporting on the module instead of replying to the person who had just typed. The tutor's role now
  lives in the system prompt, where it survives a resume, and the prompt opens the conversation.

- Curriculum problems are now resolved instead of reported. The consistency check that runs after a
  subject is written used to end by listing what it found on the subject page — a list of
  pedagogical defects in work the app did, filed against the person who asked to be taught. Each
  finding is now routed back to the lesson it names, that lesson is rewritten with the finding
  attached, and the check runs again over the result, for up to two fix-and-recheck rounds. Graph
  defects, which validation was already correcting before
  anything rendered, are logged rather than noted. What is left when the rounds run out goes to the
  log. The notes that remain on a subject page are the ones a learner can act on: a cross-topic
  connection to make, a check that could not run, a lesson that could not be written.

- Pressing a control that names AI work is now the authorisation for it. The app used to hold that
  work behind a governor: a dry-run default, an off switch, a daily cap, a stop control, and a
  dialog quoting the session count before anything ran. On a single-user app that its own author
  starts on their own machine, none of that was a decision anyone else could make — it was a second
  click on every button. The governor, its persisted state and its config are gone. The one part
  worth keeping is now a plain limit on the session runner: `LA_SESSION_CONCURRENCY` bounds how many
  provider sessions are in flight at once, and work over the limit waits rather than being refused.

### Fixed

- Uploading a PDF works in the built app. `pdfjs-dist` was being bundled by webpack along with the
  route that loads it, which broke its dynamic-import machinery, so every real PDF came back as "We
  could not read that file" while the same bytes parsed fine under the test runner. It is now a
  server-external package, left to Node's own resolver.

### Added

- A flash card library, for the things that just have to be memorised — the names of the functional
  groups, a set of unit prefixes, a table of dates. Everywhere else this app deliberately refuses to
  reward recall; names are the exception, because nothing derives them. Decks live at **Flash cards**
  in the nav, either attached to a subject or standing on their own. Cards are typed in one at a time
  or pasted in as a list, split on whatever separator the learner's own list already uses — a line
  with no two sides comes back named rather than dropped or guessed at. Studying shows the front
  alone and withholds the back until it is asked for, then three buttons record how it went. The
  schedule is the same FSRS-6 model that spaces lesson reviews, at the same intervals and with the
  same rule that the memory state never leaves the server: what the page shows is when a card comes
  back, never how well you did. Editing a card's text leaves its schedule alone.

- Initial build of the full feature set (F1-F13): topic intake and diagnostic chat, curriculum
  research and generation, lesson viewer, Socratic evaluation chat, progress tracking, the sandboxed
  Claude CLI module-authoring session, spaced review, interleaved practice, cross-topic synthesis,
  learner-set goals and self-assessment, the reflection journal, learner-directed pacing and
  branching, and the capstone project.
- Publication artifacts: this changelog, README, LICENSE, SECURITY.md, CONTRIBUTING.md, and
  `docs/TROUBLESHOOTING.md`.
