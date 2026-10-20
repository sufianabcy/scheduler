-- LMS work is no longer copied onto the plan as tasks: it showed twice on Today (in the list and in the LMS card)
-- and crowded the Plan pages. It now lives only in the LMS card on Today and the LMS tab. Remove the tasks made from
-- it; task_id and task_made stay in lms_items but are no longer used.
DELETE FROM daily_tasks WHERE id IN (SELECT task_id FROM lms_items WHERE task_id IS NOT NULL);
UPDATE lms_items SET task_id = NULL, task_made = 0;
