import { createDaily } from './daily.js';
import { createGoals } from './goals.js';
import { addDays, dayOf, timeOf } from './time.js';

const MAX_LISTED = 3;

/**
 * The two daily notifications (IST), sent to every device that turned notifications on:
 * - 23:00 "Plan tomorrow", skipped for a user who already added tasks for tomorrow.
 * - 06:00 today's plan: how many tasks, the first few, and how many are in Unfinished.
 *
 * Each is sent at most once a day. If the server was down at the exact time, it still sends within the window
 * (23:00–23:59, 06:00–08:59) but not later, so a 6 AM summary never arrives in the afternoon.
 */
export function createNotifier(db, { push, now = () => new Date() }) {
  const daily = createDaily(db);
  const goals = createGoals(db);

  const q = {
    users: db.prepare('SELECT DISTINCT user_id FROM push_subscriptions ORDER BY user_id'),
    plannedTasks: db.prepare(`
      SELECT count(*) AS n FROM daily_tasks
      WHERE user_id = ? AND day = ? AND repeating_task_id IS NULL AND status = 'open'`),
    hasRun: db.prepare('SELECT 1 FROM job_runs WHERE name = ? AND run_key = ?'),
    markRun: db.prepare('INSERT OR IGNORE INTO job_runs (name, run_key) VALUES (?, ?)'),
  };

  function evening(userId, today) {
    const tomorrow = addDays(today, 1);
    if (q.plannedTasks.get(userId, tomorrow).n > 0) return null;
    return {
      title: 'Plan tomorrow',
      body: 'Nothing planned for tomorrow yet. Two minutes now saves your morning.',
      url: `/#/plan/${tomorrow}`,
      tag: 'evening',
    };
  }

  function morning(userId, today) {
    const due = goals.dueTasks(userId, today.slice(0, 7), today).map((t) => t.title);
    const tasks = daily
      .dayTasks(userId, today, today)
      .filter((t) => t.status === 'open')
      .map((t) => t.title);
    const titles = [...due, ...tasks];
    const unfinished = daily.unfinished(userId).length;

    const lines = [];
    if (titles.length > 0) {
      const more = titles.length > MAX_LISTED ? ` +${titles.length - MAX_LISTED} more` : '';
      lines.push(titles.slice(0, MAX_LISTED).join(' · ') + more);
    } else {
      lines.push('Open the app to plan your day.');
    }
    if (unfinished > 0) lines.push(`${unfinished} unfinished from earlier days`);

    return {
      title: titles.length === 0 ? 'Nothing planned for today' : `Today: ${titles.length} task${titles.length > 1 ? 's' : ''}`,
      body: lines.join('\n'),
      url: '/#/',
      tag: 'morning',
    };
  }

  const JOBS = [
    { name: 'evening', from: '23:00', until: '23:59', ttlSeconds: 60 * 60, build: evening },
    { name: 'morning', from: '06:00', until: '08:59', ttlSeconds: 4 * 60 * 60, build: morning },
  ];

  return {
    /** The message a user would get from a job on that day, or null. Used by tests. */
    preview: (name, userId, at = now()) => JOBS.find((j) => j.name === name).build(userId, dayOf(at)),

    /** Sends any notification that is due now and hasn't been sent today. Returns what was sent. */
    async runDue(at = now()) {
      const today = dayOf(at);
      const time = timeOf(at);
      const results = [];
      for (const job of JOBS) {
        if (time < job.from || time > job.until || q.hasRun.get(job.name, today)) continue;
        // Marked before sending, so a crash or a slow push service never leads to a second copy.
        q.markRun.run(job.name, today);
        for (const { user_id: userId } of q.users.all()) {
          const message = job.build(userId, today);
          if (!message) continue;
          const result = await push.sendTo(userId, message, { ttl: job.ttlSeconds });
          results.push({ job: job.name, userId, ...result });
        }
      }
      return results;
    },
  };
}
