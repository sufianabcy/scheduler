import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Opens (or creates) the database and brings its schema up to date. Pass ':memory:' for tests. */
export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  migrate(db);
  return db;
}

/** Runs fn inside a transaction and returns its result; rolls back if it throws. */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Migrations are files named NNN_name.sql. The schema version is kept in PRAGMA user_version.
function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();

  for (const file of files) {
    const version = Number.parseInt(file, 10);
    if (version <= current) continue;
    transaction(db, () => {
      db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
      db.exec(`PRAGMA user_version = ${version}`);
    });
  }
}
