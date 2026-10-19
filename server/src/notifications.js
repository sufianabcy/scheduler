import { createDaily } from './daily.js';
import { createGoals } from './goals.js';
import { createSettings } from './settings.js';
import { addDays, dayOf, formatTime, minutesOf, timeFromMinutes, timeOf } from './time.js';

const MAX_LISTED = 3;
// How late a notification may still go out if the server was down at its time.
const DAILY_GRACE_MINUTES = { evening: 59, morning: 179 };
const TASK_GRACE_MINUTES = 15;

/**
 * Notifications, sent to every device that turned them on. Times are IST and chosen by each user:
 * - "Plan tomorrow" (default 23:00): skipped for a user who already added tasks for tomorrow.
 * - Morning summary (default 06:00): how many tasks today, the first few, and how many are in Unfinished.
 * - Task reminders: at the time set on a task (or on a repeating task, for each of its copies), if it's still open.
 *
 * Each goes out once. If the server was down at the time, it still goes out a little later (see the grace
 * minutes above, never past midnight), but not hours late.
 */
export function createNotifier(db, { push, mail = null, now = () => new Date() }) {
  const daily = createDaily(db);
  const goals = createGoals(db);
  const settings = createSettings(db);

  const q = {
    users: db.prepare('SELECT DISTINCT user_id FROM push_subscriptions ORDER BY user_id'),
    plannedTasks: db.prepare(`
      SELECT count(*) AS n FROM daily_tasks
      WHERE user_id = ? AND day = ? AND repeating_task_id IS NULL AND status = 'open'`),
    hasRun: db.prepare('SELECT 1 FROM job_runs WHERE name = ? AND run_key = ?'),
    markRun: db.prepare('INSERT OR IGNORE INTO job_runs (name, run_key) VALUES (?, ?)'),
    dueReminders: db.prepare(`
      SELECT id, title, remind_at FROM daily_tasks
      WHERE user_id = ? AND day = ? AND status = 'open' AND remind_at IS NOT NULL AND reminded_at IS NULL
        AND remind_at <= ? AND remind_at >= ?
      ORDER BY remind_at, id`),
    markReminded: db.prepare("UPDATE daily_tasks SET reminded_at = datetime('now') WHERE id = ?"),
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
    const starred = mail?.starredCount(userId) ?? 0;
    if (starred > 0) lines.push(`${starred} starred mail${starred > 1 ? 's' : ''} waiting`);

    return {
      title: titles.length === 0 ? 'Nothing planned for today' : `Today: ${titles.length} task${titles.length > 1 ? 's' : ''}`,
      body: lines.join('\n'),
      url: '/#/',
      tag: 'morning',
    };
  }

  /** The user's time for a daily notification, or null if they turned it off. */
  function scheduled(name, userId) {
    const s = settings.row(userId);
    if (name === 'evening') return s.evening_on ? s.evening_time : null;
    return s.morning_on ? s.morning_time : null;
  }

  /** True if `time` is at or after `start`, but no more than `grace` minutes after it (and not past midnight). */
  const inWindow = (time, start, grace) => time >= start && minutesOf(time) - minutesOf(start) <= grace;

  const JOBS = [
    { name: 'evening', ttlSeconds: 60 * 60, build: evening },
    { name: 'morning', ttlSeconds: 4 * 60 * 60, build: morning },
  ];

  async function dailyNotifications(userId, today, time, results) {
    for (const job of JOBS) {
      const start = scheduled(job.name, userId);
      if (!start || !inWindow(time, start, DAILY_GRACE_MINUTES[job.name])) continue;
      const key = `${today}#${userId}`;
      if (q.hasRun.get(job.name, key)) continue;
      // Marked before sending, so a crash or a slow push service never leads to a second copy.
      q.markRun.run(job.name, key);
      const message = job.build(userId, today);
      if (!message) continue;
      results.push({ job: job.name, userId, ...(await push.sendTo(userId, message, { ttl: job.ttlSeconds })) });
    }
  }

  async function taskReminders(userId, today, time, results) {
    // Makes sure today's repeating tasks exist, so their reminders fire even if the app wasn't opened today.
    daily.generate(userId, today);
    const earliest = timeFromMinutes(Math.max(0, minutesOf(time) - TASK_GRACE_MINUTES));
    for (const task of q.dueReminders.all(userId, today, time, earliest)) {
      q.markReminded.run(task.id);
      const message = { title: task.title, body: `Reminder · ${formatTime(task.remind_at)}`, url: '/#/', tag: `task-${task.id}` };
      results.push({ job: 'task', userId, taskId: task.id, ...(await push.sendTo(userId, message, { ttl: 60 * 60 })) });
    }
  }

  return {
    /** The message a user would get from a daily notification on that day, or null. Used by tests. */
    preview: (name, userId, at = now()) => JOBS.find((j) => j.name === name).build(userId, dayOf(at)),

    /** Sends whatever is due now and hasn't been sent yet. Returns what was sent. */
    async runDue(at = now()) {
      const today = dayOf(at);
      const time = timeOf(at);
      const results = [];
      for (const { user_id: userId } of q.users.all()) {
        await dailyNotifications(userId, today, time, results);
        await taskReminders(userId, today, time, results);
      }
      return results;
    },
  };
}
