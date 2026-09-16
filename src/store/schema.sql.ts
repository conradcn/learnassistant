// FRACTAL: implements F5, F13 | component C1

export type MigrationStep = { version: number; sql: string };

export const MIGRATIONS: MigrationStep[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO meta (key, value) VALUES ('schemaVersion', '1');

      CREATE TABLE topics (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        level TEXT NOT NULL,
        level_detail TEXT,
        purpose TEXT NOT NULL,
        driving_question TEXT,
        status TEXT NOT NULL,
        diagnostic_json TEXT,
        notes_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        degraded INTEGER NOT NULL DEFAULT 0,
        degraded_reason TEXT,
        raw_json TEXT
      );

      CREATE TABLE module_nodes (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL REFERENCES topics(id),
        title TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL,
        test_out_eligible INTEGER NOT NULL,
        estimated_minutes INTEGER NOT NULL,
        state TEXT NOT NULL,
        content_json TEXT,
        last_verdict_json TEXT,
        last_verdict_at TEXT
      );
      CREATE INDEX idx_module_nodes_topic ON module_nodes(topic_id);

      CREATE TABLE prereq_edges (
        topic_id TEXT NOT NULL REFERENCES topics(id),
        from_module TEXT NOT NULL,
        to_module TEXT NOT NULL,
        PRIMARY KEY (topic_id, from_module, to_module)
      );
      CREATE INDEX idx_prereq_edges_topic ON prereq_edges(topic_id);

      CREATE TABLE module_graph_entry (
        topic_id TEXT NOT NULL REFERENCES topics(id),
        module_id TEXT NOT NULL,
        PRIMARY KEY (topic_id, module_id)
      );

      CREATE TABLE eval_sessions (
        id TEXT PRIMARY KEY,
        module_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        consecutive_failures INTEGER NOT NULL,
        status TEXT NOT NULL,
        opened_at TEXT NOT NULL
      );

      CREATE TABLE eval_turns (
        session_id TEXT NOT NULL REFERENCES eval_sessions(id),
        ordinal INTEGER NOT NULL,
        turn_json TEXT NOT NULL,
        PRIMARY KEY (session_id, ordinal)
      );

      CREATE TABLE review_items (
        module_id TEXT PRIMARY KEY,
        due_at TEXT NOT NULL,
        interval_days REAL NOT NULL,
        ease REAL NOT NULL,
        lapses INTEGER NOT NULL,
        last_assist_level INTEGER NOT NULL,
        flagged_needs_review INTEGER NOT NULL
      );
      CREATE INDEX idx_review_items_due ON review_items(due_at);

      CREATE TABLE practice_sessions (
        id TEXT PRIMARY KEY,
        answered_count INTEGER NOT NULL,
        stopped_early INTEGER NOT NULL,
        questions_json TEXT NOT NULL
      );

      CREATE TABLE reflections (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL,
        module_id TEXT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_reflections_topic ON reflections(topic_id);

      CREATE TABLE predictions (
        module_id TEXT PRIMARY KEY,
        confidence INTEGER NOT NULL,
        expectation TEXT NOT NULL,
        skipped INTEGER NOT NULL,
        at TEXT NOT NULL
      );

      CREATE TABLE calibration (
        module_id TEXT PRIMARY KEY,
        predicted INTEGER,
        actual_assist_level INTEGER NOT NULL,
        self_vs_evaluator_json TEXT NOT NULL
      );

      CREATE TABLE capstones (
        topic_id TEXT PRIMARY KEY,
        module_id TEXT NOT NULL,
        spec TEXT NOT NULL,
        driving_question_ref TEXT NOT NULL,
        purpose_ref TEXT NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE capstone_submissions (
        topic_id TEXT NOT NULL REFERENCES capstones(topic_id),
        round INTEGER NOT NULL,
        artifact TEXT NOT NULL,
        feedback TEXT,
        verdict_json TEXT,
        at TEXT NOT NULL,
        PRIMARY KEY (topic_id, round)
      );

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        topic_id TEXT NOT NULL,
        module_id TEXT,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        error_json TEXT,
        queued_at TEXT NOT NULL
      );
      CREATE INDEX idx_jobs_status ON jobs(status, queued_at);
    `,
  },
  // WHY the gap at 2: versions 1 and 2 used to create and repair a `dispatch_state` row,
  // which recorded whether AI work was permitted. Nothing asks that question any more —
  // this is a single-user local app and the click is the authorisation — so the table is
  // no longer created here and version 3 removes it from stores that already have it. The
  // number is left unused rather than reused: a store that recorded 2 must not be re-run
  // at 2.
  {
    version: 3,
    sql: `
      DROP TABLE IF EXISTS dispatch_state;
    `,
  },
  // The index of the material the learner brought. The text itself is NOT here: it is a
  // whole textbook's worth of characters, it is read as a stream by the chunker rather
  // than by a query, and a row that size makes every unrelated `SELECT *` on this store
  // pay for it. The bytes live under `<dataRoot>/topics/<topic>/source/`, the same place
  // and under the same confinement as the module directories; this table is the record of
  // what is there and what was read out of it.
  {
    version: 4,
    sql: `
      CREATE TABLE source_documents (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL REFERENCES topics(id),
        filename TEXT NOT NULL,
        kind TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        char_count INTEGER NOT NULL,
        page_count INTEGER,
        truncated INTEGER NOT NULL,
        units_json TEXT NOT NULL,
        added_at TEXT NOT NULL
      );
      CREATE INDEX idx_source_documents_topic ON source_documents(topic_id);
    `,
  },
  // F7's scheduler moved from a hand-rolled SM-2 (a multiplicative `ease`, decremented on
  // every miss and never restored) to FSRS-6's DSR memory model. The research behind the
  // move, and the parts of FSRS we declined, are in `docs/spaced-repetition.md`.
  //
  // WHY the backfill and not a reset: a learner mid-course must keep their schedule.
  // Stability seeds from the stored interval because the two mean the same thing in the
  // same units — FSRS defines stability as the interval at which recall probability reaches
  // 0.9, and the old interval was that scheduler's estimate of when the item needed
  // revisiting. Difficulty interpolates `ease` between its two fixed points: 2.5 is the
  // start value, only held by an item that never lapsed, which is FSRS's `good`-graded
  // card at difficulty 2.1181; 1.3 is the floor and maps to FSRS's maximum of 10. Those
  // two anchors are read off the algorithm in `@/review/memory` and asserted against these
  // literals by `tests/review/migration.test.ts`, so a `ts-fsrs` upgrade cannot silently
  // desync them.
  //
  // `last_reviewed_at` stays NULL: these rows never recorded when they were last answered.
  // The reader derives it from `due_at - interval_days`, which is the same estimate the
  // stability seed rests on.
  {
    version: 5,
    sql: `
      ALTER TABLE review_items ADD COLUMN stability REAL NOT NULL DEFAULT 0;
      ALTER TABLE review_items ADD COLUMN difficulty REAL NOT NULL DEFAULT 0;
      ALTER TABLE review_items ADD COLUMN reps INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE review_items ADD COLUMN last_reviewed_at TEXT;

      UPDATE review_items SET
        stability = round(max(0.001, interval_days), 4),
        difficulty = round(
          min(10.0, max(1.0,
            2.1181 + min(1.0, max(0.0, (2.5 - ease) / 1.2)) * (10.0 - 2.1181)
          )), 4),
        reps = 1,
        last_reviewed_at = NULL;

      ALTER TABLE review_items DROP COLUMN ease;
    `,
  },
  // F14's flash card library. A card carries the same DSR memory columns a `review_items`
  // row does, because it is scheduled by the same model (`@/review/memory`) — but it is its
  // own table rather than a `module_id`-keyed row, because a card is not a module: it has
  // two sides the learner wrote, it belongs to a deck, and a deck may belong to no subject
  // at all. A brand new card is due immediately with a zeroed memory; `reps = 0` is what
  // marks it as never yet answered, and is what sends the first grade through
  // `firstSchedule` rather than `nextSchedule`.
  {
    version: 6,
    sql: `
      CREATE TABLE card_decks (
        id TEXT PRIMARY KEY,
        topic_id TEXT REFERENCES topics(id),
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_card_decks_topic ON card_decks(topic_id);

      CREATE TABLE cards (
        id TEXT PRIMARY KEY,
        deck_id TEXT NOT NULL REFERENCES card_decks(id) ON DELETE CASCADE,
        front TEXT NOT NULL,
        back TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        due_at TEXT NOT NULL,
        interval_days REAL NOT NULL,
        lapses INTEGER NOT NULL,
        stability REAL NOT NULL,
        difficulty REAL NOT NULL,
        reps INTEGER NOT NULL,
        last_reviewed_at TEXT
      );
      CREATE INDEX idx_cards_deck ON cards(deck_id);
      CREATE INDEX idx_cards_due ON cards(due_at);
    `,
  },
  // The history `review_items` cannot hold. That table is keyed on `module_id` alone and
  // every graded retrieval overwrites it, so the store knew the learner's *current* memory
  // state and nothing about how it got there — and the grade, the one input the memory
  // model actually consumes, was never written down at all. This table is append-only: one
  // row per graded retrieval, never updated, never deleted alongside its module.
  //
  // WHY the before-columns are nullable: the first schedule for a module has no prior state
  // to record. WHY there is no foreign key onto `module_nodes`: the point of a log is to
  // survive the thing it describes — a deleted subject takes its modules with it, and the
  // record that those reviews happened must outlive that.
  {
    version: 7,
    sql: `
      CREATE TABLE review_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        module_id TEXT NOT NULL,
        reviewed_at TEXT NOT NULL,
        grade TEXT NOT NULL,
        stability_before REAL,
        difficulty_before REAL,
        reps_before INTEGER,
        interval_days_before REAL,
        stability_after REAL NOT NULL,
        difficulty_after REAL NOT NULL,
        reps_after INTEGER NOT NULL,
        interval_days_after REAL NOT NULL
      );
      CREATE INDEX idx_review_log_module ON review_log(module_id, id);
    `,
  },
];

export const HIGHEST_KNOWN_MIGRATION = MIGRATIONS[MIGRATIONS.length - 1].version;
