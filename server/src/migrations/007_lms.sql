-- KL University LMS (Moodle): what you owe there, synced into the planner. Times ending in _at are UTC ISO 8601.

-- One LMS connection per user. token is the Moodle web-service token, encrypted with LMS_TOKEN_KEY (see
-- mail/crypto.js); the password is never stored. functions: the web-service functions this token may call (JSON).
-- semester_start ('YYYY-MM-DD', IST): how far back to look; NULL means 180 days.
CREATE TABLE lms_accounts (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token          TEXT NOT NULL,
  moodle_user_id INTEGER NOT NULL,
  functions      TEXT NOT NULL DEFAULT '[]',
  semester_start TEXT,
  status         TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'needs_reconnect')),
  last_synced_at TEXT,
  last_error     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Courses seen on the LMS. lists_day: the IST day the course's assignment and quiz lists were last fetched
-- (they're fetched at most once a day). project_id: a project you linked the course to.
CREATE TABLE lms_courses (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id  INTEGER NOT NULL,
  name       TEXT NOT NULL,
  short_name TEXT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  hidden     INTEGER NOT NULL DEFAULT 0,
  lists_day  TEXT,
  PRIMARY KEY (user_id, course_id)
);

-- One row per activity with a deadline. id: '<module>:<course module id>', e.g. 'assign:4182'.
-- status: upcoming (due later), overdue (due date passed, still accepted), missed (no longer accepted),
-- done (submitted or attempted). task_made: a planner task was made once, so a deleted task isn't made again.
-- checked_at: when its submission or attempts were last looked up (never for activities only known from the
-- calendar). missed_sent: the "missed" notification went out (or wasn't needed: it was already missed when first seen).
CREATE TABLE lms_items (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  course_id     INTEGER NOT NULL,
  course_name   TEXT NOT NULL,
  kind          TEXT NOT NULL,
  instance_id   INTEGER,
  title         TEXT NOT NULL,
  url           TEXT,
  opens_at      TEXT,
  due_at        TEXT,
  cutoff_at     TEXT,
  status        TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'overdue', 'missed', 'done')),
  submitted_at  TEXT,
  grade         TEXT,
  task_id       INTEGER REFERENCES daily_tasks(id) ON DELETE SET NULL,
  task_made     INTEGER NOT NULL DEFAULT 0,
  checked_at    TEXT,
  missed_sent   INTEGER NOT NULL DEFAULT 0,
  last_seen_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX lms_items_user_status ON lms_items(user_id, status, due_at);
CREATE INDEX lms_items_task ON lms_items(task_id) WHERE task_id IS NOT NULL;
