-- Google Tasks-style repeats: every N days / weeks (on chosen weekdays) / months, from a start day, optionally
-- until an end day. Rows from before this migration were weekly from the day they were created.
ALTER TABLE repeating_tasks ADD COLUMN freq TEXT NOT NULL DEFAULT 'weekly' CHECK (freq IN ('daily', 'weekly', 'monthly'));
ALTER TABLE repeating_tasks ADD COLUMN every INTEGER NOT NULL DEFAULT 1 CHECK (every BETWEEN 1 AND 99);
ALTER TABLE repeating_tasks ADD COLUMN start_day TEXT;
ALTER TABLE repeating_tasks ADD COLUMN end_day TEXT;
-- 'HH:MM' (IST) to send a reminder for each copy, or NULL.
ALTER TABLE repeating_tasks ADD COLUMN remind_at TEXT;
UPDATE repeating_tasks SET start_day = substr(created_at, 1, 10);

-- Per-task reminder: 'HH:MM' (IST) on the task's day. reminded_at is set once it has been sent.
ALTER TABLE daily_tasks ADD COLUMN remind_at TEXT;
ALTER TABLE daily_tasks ADD COLUMN reminded_at TEXT;
CREATE INDEX daily_tasks_reminders ON daily_tasks(day, remind_at)
  WHERE remind_at IS NOT NULL AND reminded_at IS NULL;

-- When each user wants the two daily notifications. A missing row means the defaults.
CREATE TABLE notification_settings (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  evening_on   INTEGER NOT NULL DEFAULT 1,
  evening_time TEXT NOT NULL DEFAULT '23:00',
  morning_on   INTEGER NOT NULL DEFAULT 1,
  morning_time TEXT NOT NULL DEFAULT '06:00'
);
