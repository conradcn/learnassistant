// FRACTAL: implements F5, F1, F13 | component C1
import type Database from 'better-sqlite3';
import { err } from '@/core/errors';
import { MIGRATIONS, type MigrationStep } from '@/store/schema.sql';

export { HIGHEST_KNOWN_MIGRATION } from '@/store/schema.sql';

function currentSchemaVersion(db: Database.Database): number {
  const row = db.pragma('user_version', { simple: true }) as number;
  return row;
}

export function readRecordedVersion(db: Database.Database): number {
  return currentSchemaVersion(db);
}

/** Returns the number of migration steps applied — zero when the database was already current. */
export function runMigrations(db: Database.Database, steps: MigrationStep[] = MIGRATIONS): number {
  const recorded = currentSchemaVersion(db);
  const highest = steps.reduce((max, s) => Math.max(max, s.version), 0);
  if (recorded > highest) {
    throw err('store-schema-ahead', {
      detail: `recorded schema version ${recorded} exceeds highest known migration ${highest}`,
    });
  }

  const pending = steps.filter((m) => m.version > recorded).sort((a, b) => a.version - b.version);

  for (const step of pending) {
    const run = db.transaction(() => {
      db.exec(step.sql);
      db.pragma(`user_version = ${step.version}`);
    });
    try {
      run();
    } catch (e) {
      throw err('store-corrupt', {
        detail: `migration to version ${step.version} failed and was rolled back`,
        cause: e,
      });
    }
  }

  return pending.length;
}
