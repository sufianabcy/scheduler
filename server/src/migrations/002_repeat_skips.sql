-- Days on which a repeating task was deleted from the plan, so it isn't added back to that day.
CREATE TABLE repeat_skips (
  repeating_task_id INTEGER NOT NULL REFERENCES repeating_tasks(id) ON DELETE CASCADE,
  day               TEXT NOT NULL,
  PRIMARY KEY (repeating_task_id, day)
);
