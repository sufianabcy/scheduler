-- Full schema for v1. Days are 'YYYY-MM-DD' and months 'YYYY-MM', both in IST.
-- Timestamps are UTC 'YYYY-MM-DD HH:MM:SS' unless the column name ends in _ms.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The cookie holds a random token; only its SHA-256 is stored here.
CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_ms    INTEGER NOT NULL,
  expires_ms    INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- ---------- Daily plan ----------

-- weekdays is a bitmask: Mon=1, Tue=2, Wed=4, Thu=8, Fri=16, Sat=32, Sun=64 (127 = every day).
CREATE TABLE repeating_tasks (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  weekdays   INTEGER NOT NULL CHECK (weekdays BETWEEN 1 AND 127),
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX repeating_tasks_user ON repeating_tasks(user_id);

-- status: open (planned for `day`), done, unfinished (not done by midnight; shown in the Unfinished list),
-- missed (a repeating task that wasn't done; it never goes to Unfinished).
CREATE TABLE daily_tasks (
  id                INTEGER PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  day               TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'unfinished', 'missed')),
  position          INTEGER NOT NULL DEFAULT 0,
  repeating_task_id INTEGER REFERENCES repeating_tasks(id) ON DELETE SET NULL,
  done_at           TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX daily_tasks_user_day ON daily_tasks(user_id, day);
CREATE INDEX daily_tasks_user_status ON daily_tasks(user_id, status);
-- A repeating task is added to a given day at most once.
CREATE UNIQUE INDEX daily_tasks_repeat_once ON daily_tasks(repeating_task_id, day)
  WHERE repeating_task_id IS NOT NULL;

-- ---------- Monthly goals ----------

CREATE TABLE monthly_goals (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  month        TEXT NOT NULL,
  carried_from TEXT,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX monthly_goals_user_month ON monthly_goals(user_id, month);

-- Tasks are done in `position` order; only the first one not done is open.
CREATE TABLE goal_tasks (
  id         INTEGER PRIMARY KEY,
  goal_id    INTEGER NOT NULL REFERENCES monthly_goals(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  due_day    TEXT,
  done_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX goal_tasks_goal ON goal_tasks(goal_id, position);

-- ---------- Projects (general goals) ----------

CREATE TABLE projects (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX projects_user ON projects(user_id);

-- Steps are done in `position` order; only the first one not done is open.
CREATE TABLE project_steps (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  done_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX project_steps_project ON project_steps(project_id, position);

-- A step's own checklist.
CREATE TABLE step_items (
  id         INTEGER PRIMARY KEY,
  step_id    INTEGER NOT NULL REFERENCES project_steps(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  done_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX step_items_step ON step_items(step_id, position);

CREATE TABLE templates (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX templates_user ON templates(user_id);

-- items is a JSON array of checklist item titles for the step.
CREATE TABLE template_steps (
  id          INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  items       TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX template_steps_template ON template_steps(template_id, position);

-- ---------- Notifications and jobs ----------

CREATE TABLE push_subscriptions (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);

-- One row per finished job run (e.g. name 'midnight', run_key '2026-10-16'), so a job is never run twice
-- and a run missed while the server was down can be caught up on start.
CREATE TABLE job_runs (
  name       TEXT NOT NULL,
  run_key    TEXT NOT NULL,
  ran_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (name, run_key)
);
