import { transaction } from './db.js';
import { dayOf, monthOf, weekStart } from './time.js';

/**
 * The midnight rollover, run once per IST day for all users:
 * 1. Open tasks from earlier days go to the Unfinished list (repeating ones become "missed").
 * 2. Unfinished monthly-goal tasks whose date has passed move to today.
 * 3. Finished and missed daily tasks from before this week (Monday) are deleted.
 * 4. Goals from earlier months: fully finished ones are deleted; the rest move to this month,
 *    remembering the month they first came from.
 * *
 * Each run is recorded in job_runs, so it never runs twice for a day. If the server was down at midnight,
 * the next check catches up (the steps don't depend on how many days were missed).
 */
export function rollover(db, today, month) {
  db.prepare(`
    UPDATE daily_tasks
    SET status = CASE WHEN repeating_task_id IS NULL THEN 'unfinished' ELSE 'missed' END
    WHERE status = 'open' AND day < ?`).run(today);

  db.prepare('UPDATE goal_tasks SET due_day = ? WHERE done_at IS NULL AND due_day < ?').run(today, today);

  db.prepare("DELETE FROM daily_tasks WHERE status IN ('done', 'missed') AND day < ?").run(weekStart(today));
  db.prepare('DELETE FROM repeat_skips WHERE day < ?').run(today);

  db.prepare(`
    DELETE FROM monthly_goals
    WHERE month < ?
      AND EXISTS (SELECT 1 FROM goal_tasks t WHERE t.goal_id = monthly_goals.id)
      AND NOT EXISTS (SELECT 1 FROM goal_tasks t WHERE t.goal_id = monthly_goals.id AND t.done_at IS NULL)`).run(month);
  db.prepare(`
    UPDATE monthly_goals SET carried_from = coalesce(carried_from, month), month = ?
    WHERE month < ?`).run(month, month);

  db.prepare("DELETE FROM job_runs WHERE ran_at < datetime('now', '-60 days')").run();
}

/**
 * `notifier` (optional) sends the 23:00 and 06:00 notifications on the same timer; `mail` (optional) syncs mail
 * accounts that are due (every 5 minutes); `lms` (optional) syncs LMS accounts that are due (every 2 hours).
 */
export function createJobs(db, { now = () => new Date(), notifier, mail, lms } = {}) {
  const hasRun = db.prepare('SELECT 1 FROM job_runs WHERE name = ? AND run_key = ?');
  const markRun = db.prepare('INSERT INTO job_runs (name, run_key) VALUES (?, ?)');

  /** Runs today's rollover if it hasn't run yet. Cheap enough to call before every daily-plan request. */
  function runDue(at = now()) {
    const today = dayOf(at);
    if (hasRun.get('rollover', today)) return false;
    transaction(db, () => {
      rollover(db, today, monthOf(at));
      markRun.run('rollover', today);
    });
    return true;
  }

  return {
    runDue,

    /** Checks once now and then every minute. Returns a function that stops the timer. */
    start(intervalMs = 60_000) {
      const tick = () => {
        try {
          if (runDue()) console.log(`Rollover done for ${dayOf(now())}`);
        } catch (err) {
          console.error('Rollover failed', err);
        }
        notifier
          ?.runDue()
          .then((results) => results.forEach((r) => console.log(`Sent ${r.job} notification to user ${r.userId}: ${r.sent} ok, ${r.failed} failed`)))
          .catch((err) => console.error('Notifications failed', err));
        mail?.runDue().catch((err) => console.error(`Mail sync failed: ${err.status ?? ''} ${err.code ?? err.name}`));
        lms?.runDue().catch((err) => console.error(`LMS sync failed: ${err.code ?? err.name}`));
      };
      tick();
      const timer = setInterval(tick, intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
