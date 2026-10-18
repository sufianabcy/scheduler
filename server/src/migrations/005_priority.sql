-- Task priority: 1 (highest) to 3, or NULL for none. P1 tasks are listed first.
-- Repeating tasks pass their priority on to each copy.
ALTER TABLE daily_tasks ADD COLUMN priority INTEGER CHECK (priority IN (1, 2, 3));
ALTER TABLE repeating_tasks ADD COLUMN priority INTEGER CHECK (priority IN (1, 2, 3));
