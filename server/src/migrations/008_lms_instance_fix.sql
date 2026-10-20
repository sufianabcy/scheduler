-- The first LMS sync took assignment and quiz ids from the calendar, which on this LMS gives course module ids, so
-- submission checks failed. Forget those ids and re-read the course lists on the next sync to get the right ones.
UPDATE lms_items SET instance_id = NULL WHERE checked_at IS NULL;
UPDATE lms_courses SET lists_day = NULL;
