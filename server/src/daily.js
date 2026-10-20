import { transaction } from './db.js';
import { badRequest, conflict, notFound } from './http.js';
import { nextOccurrence, occursOn } from './recurrence.js';
import { weekdayIndex } from './time.js';

// Weekly repeats store their weekdays as a bitmask (Mon = 1 … Sun = 64); the API uses day names.
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const maskOf = (names) => names.reduce((mask, name) => mask | (1 << WEEKDAYS.indexOf(name)), 0);
export const namesOf = (mask) => WEEKDAYS.filter((_, i) => mask & (1 << i));
export const FREQS = ['daily', 'weekly', 'monthly'];

/** How a rule repeats, as the API shows it. */
const repeatJson = (freq, every, weekdays, startDay, endDay) => ({
  freq,
  every,
  weekdays: freq === 'weekly' ? namesOf(weekdays) : [],
  startDay,
  until: endDay,
});

const taskJson = (t) => ({
  id: t.id,
  title: t.title,
  day: t.day,
  status: t.status,
  repeating: t.repeating_task_id !== null,
  repeat:
    t.repeating_task_id !== null && t.r_freq
      ? { ruleId: t.repeating_task_id, ...repeatJson(t.r_freq, t.r_every, t.r_weekdays, t.r_start_day, t.r_end_day) }
      : null,
  remindAt: t.remind_at,
  priority: t.priority,
  // A task made from a mail: messageId while the mail is still synced, link to open it at Gmail/Outlook.
  mail: t.mail_message_id !== null || t.mail_link !== null ? { messageId: t.mail_message_id, link: t.mail_link } : null,
  // A task made from LMS work: its LMS status (done once submitted there), due time (UTC ISO), course and link.
  lms: t.lms_id ? { itemId: t.lms_id, status: t.lms_status, dueAt: t.lms_due_at, course: t.lms_course, url: t.lms_url } : null,
  doneAt: t.done_at,
});

const ruleJson = (r) => ({
  id: r.id,
  title: r.title,
  ...repeatJson(r.freq, r.every, r.weekdays, r.start_day, r.end_day),
  remindAt: r.remind_at,
  priority: r.priority,
  active: r.active === 1,
});

/**
 * Turns an API repeat ({ freq, every, weekdays, until }) into rule columns. A weekly repeat with no weekdays
 * repeats on the start day's weekday, like Google Tasks.
 */
function ruleColumns({ freq, every = 1, weekdays, until = null }, startDay) {
  if (until && until < startDay) throw badRequest('The repeat must end on or after the day it starts');
  const days = weekdays?.length ? weekdays : [WEEKDAYS[weekdayIndex(startDay)]];
  return { freq, every, mask: freq === 'weekly' ? maskOf(days) : 127, endDay: until };
}

// Highest priority first; tasks without one after P3.
const BY_PRIORITY = 'coalesce(t.priority, 4)';

const TASK_WITH_RULE = `
  SELECT t.*, r.freq AS r_freq, r.every AS r_every, r.weekdays AS r_weekdays,
         r.start_day AS r_start_day, r.end_day AS r_end_day,
         li.id AS lms_id, li.status AS lms_status, li.due_at AS lms_due_at, li.course_name AS lms_course, li.url AS lms_url
  FROM daily_tasks t LEFT JOIN repeating_tasks r ON r.id = t.repeating_task_id
  LEFT JOIN lms_items li ON li.task_id = t.id`;

/**
 * The daily plan: one checklist per day, repeating tasks, reminders, and the Unfinished list.
 * `today` is passed in by the caller (IST), so the rules can be tested with any date.
 *
 * Statuses: open → done when ticked. At midnight an open task from an earlier day becomes unfinished
 * (or missed, for a repeating task); see jobs.js.
 */
export function createDaily(db) {
  const q = {
    task: db.prepare('SELECT * FROM daily_tasks WHERE id = ? AND user_id = ?'),
    taskJson: db.prepare(`${TASK_WITH_RULE} WHERE t.id = ?`),
    // A day's checklist. Unfinished tasks keep their old day but are shown in the Unfinished list instead.
    dayTasks: db.prepare(`${TASK_WITH_RULE} WHERE t.user_id = ? AND t.day = ? AND t.status != 'unfinished' ORDER BY ${BY_PRIORITY}, t.position, t.id`),
    unfinished: db.prepare(`${TASK_WITH_RULE} WHERE t.user_id = ? AND t.status = 'unfinished' ORDER BY ${BY_PRIORITY}, t.day, t.position, t.id`),
    insertTask: db.prepare(`
      INSERT INTO daily_tasks (user_id, title, day, remind_at, priority, mail_message_id, mail_link, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT coalesce(max(position), -1) + 1 FROM daily_tasks WHERE user_id = ? AND day = ?))`),
    rename: db.prepare('UPDATE daily_tasks SET title = ? WHERE id = ?'),
    setStatus: db.prepare(`
      UPDATE daily_tasks
      SET status = ?, done_at = CASE WHEN ? = 'done' THEN datetime('now') ELSE NULL END
      WHERE id = ?`),
    move: db.prepare(`
      UPDATE daily_tasks
      SET day = ?, status = ?, reminded_at = NULL,
          position = (SELECT coalesce(max(position), -1) + 1 FROM daily_tasks WHERE user_id = ? AND day = ?)
      WHERE id = ?`),
    setPosition: db.prepare('UPDATE daily_tasks SET position = ? WHERE id = ?'),
    setRemind: db.prepare('UPDATE daily_tasks SET remind_at = ?, reminded_at = NULL WHERE id = ?'),
    setPriority: db.prepare('UPDATE daily_tasks SET priority = ? WHERE id = ?'),
    link: db.prepare('UPDATE daily_tasks SET repeating_task_id = ? WHERE id = ?'),
    removeTask: db.prepare('DELETE FROM daily_tasks WHERE id = ?'),

    rules: db.prepare('SELECT * FROM repeating_tasks WHERE user_id = ? ORDER BY id'),
    activeRules: db.prepare('SELECT * FROM repeating_tasks WHERE user_id = ? AND active = 1'),
    rule: db.prepare('SELECT * FROM repeating_tasks WHERE id = ? AND user_id = ?'),
    insertRule: db.prepare(`
      INSERT INTO repeating_tasks (user_id, title, freq, every, weekdays, start_day, end_day, remind_at, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateRule: db.prepare(`
      UPDATE repeating_tasks SET title = ?, freq = ?, every = ?, weekdays = ?, end_day = ?, remind_at = ?, active = ?
      WHERE id = ?`),
    setRulePriority: db.prepare('UPDATE repeating_tasks SET priority = ? WHERE id = ?'),
    removeRule: db.prepare('DELETE FROM repeating_tasks WHERE id = ?'),
    // Copies go first in the day's list (position -1). The unique index makes this a no-op once added.
    insertCopy: db.prepare(`
      INSERT OR IGNORE INTO daily_tasks (user_id, title, day, repeating_task_id, remind_at, priority, position)
      SELECT ?, ?, ?, ?, ?, ?, -1
      WHERE NOT EXISTS (SELECT 1 FROM repeat_skips WHERE repeating_task_id = ? AND day = ?)`),
    // "Upcoming" = open copies from today on. Past days are never rewritten.
    renameUpcoming: db.prepare(`
      UPDATE daily_tasks SET title = ? WHERE repeating_task_id = ? AND status = 'open' AND day >= ?`),
    remindUpcoming: db.prepare(`
      UPDATE daily_tasks SET remind_at = ?, reminded_at = NULL WHERE repeating_task_id = ? AND status = 'open' AND day >= ?`),
    prioritizeUpcoming: db.prepare(`
      UPDATE daily_tasks SET priority = ? WHERE repeating_task_id = ? AND status = 'open' AND day >= ?`),
    removeUpcoming: db.prepare(`
      DELETE FROM daily_tasks WHERE repeating_task_id = ? AND status = 'open' AND day >= ? AND id != ?`),
    skip: db.prepare('INSERT OR IGNORE INTO repeat_skips (repeating_task_id, day) VALUES (?, ?)'),
  };

  function ownedTask(userId, taskId) {
    const task = q.task.get(taskId, userId);
    if (!task) throw notFound('No such task');
    return task;
  }

  function ownedRule(userId, ruleId) {
    const rule = q.rule.get(ruleId, userId);
    if (!rule) throw notFound('No such repeating task');
    return rule;
  }

  /** Adds the user's repeating tasks to a day (today or later) the first time that day is looked at. */
  function generate(userId, day) {
    for (const rule of q.activeRules.all(userId)) {
      if (occursOn(rule, day)) q.insertCopy.run(userId, rule.title, day, rule.id, rule.remind_at, rule.priority, rule.id, day);
    }
  }

  function dayTasks(userId, day, today) {
    if (day >= today) generate(userId, day);
    return q.dayTasks.all(userId, day).map(taskJson);
  }

  function noPastDay(day, today) {
    if (day < today) throw badRequest("Past days can't be planned");
  }

  /** Creates a rule and returns it (as a row). */
  function createRule(userId, { title, repeat, startDay, remindAt = null, priority = null }) {
    const c = ruleColumns(repeat, startDay);
    const { lastInsertRowid } = q.insertRule.run(userId, title, c.freq, c.every, c.mask, startDay, c.endDay, remindAt, priority);
    return ownedRule(userId, Number(lastInsertRowid));
  }

  return {
    dayTasks,
    generate,

    unfinished: (userId) => q.unfinished.all(userId).map(taskJson),

    /**
     * Adds a task to a day. With `repeat`, it becomes the first of a repeating series starting that day.
     * `mail` ({ messageId, link }) links a one-off task to the mail it was made from.
     * Returns { tasks, firstDay }: firstDay is when the series first happens (the same day unless the chosen
     * weekdays skip it).
     */
    addTask(userId, day, { title, repeat = null, remindAt = null, priority = null, mail = null }, today) {
      noPastDay(day, today);
      let firstDay = day;
      transaction(db, () => {
        if (repeat) {
          const rule = createRule(userId, { title, repeat, startDay: day, remindAt, priority });
          firstDay = nextOccurrence(rule, day);
          generate(userId, day);
        } else {
          q.insertTask.run(userId, title, day, remindAt, priority, mail?.messageId ?? null, mail?.link ?? null, userId, day);
        }
      });
      return { tasks: dayTasks(userId, day, today), firstDay };
    },

    /**
     * changes: { title?, done?, day?, repeat?, remindAt?, priority? } — `done` and `day` can't be sent together.
     * - done: true ticks an open or unfinished task. Ticking from the Unfinished list moves it to today, so it
     *   shows on the day it was finished.
     * - done: false unticks; a task from an earlier day goes back to unfinished (or missed if repeating).
     * - day moves an open or unfinished task to that day (today or later). Repeating tasks can't be moved.
     * - repeat: null stops a repeating task (this copy stays as a one-off; its upcoming copies go).
     *   An object makes a one-off task repeat from its day, or changes how a repeating one repeats.
     * - title, remindAt and priority on a repeating task change the whole series from today on, like Google Tasks.
     * - priority: 1 (highest) to 3, or null. Higher-priority tasks are listed first.
     */
    updateTask(userId, taskId, { title, done, day, repeat, remindAt, priority }, today) {
      const task = ownedTask(userId, taskId);
      const repeating = task.repeating_task_id !== null;

      if (done === true && task.status === 'missed') throw conflict("A missed task from an earlier day can't be ticked");
      if (day !== undefined) {
        if (repeating) throw conflict("Repeating tasks can't be moved to another day; delete this one instead");
        if (task.status === 'done' || task.status === 'missed') throw conflict('Only unfinished tasks can be moved');
        noPastDay(day, today);
      }

      transaction(db, () => {
        let ruleId = task.repeating_task_id;
        if (repeat === null && ruleId !== null) {
          q.removeUpcoming.run(ruleId, today, taskId);
          q.removeRule.run(ruleId); // this and past copies are unlinked (ON DELETE SET NULL)
          ruleId = null;
        } else if (repeat && ruleId === null) {
          const rule = createRule(userId, {
            title: title ?? task.title,
            repeat,
            startDay: task.day > today ? task.day : today,
            remindAt: remindAt !== undefined ? remindAt : task.remind_at,
            priority: priority !== undefined ? priority : task.priority,
          });
          if (task.status === 'open' && task.day >= today && occursOn(rule, task.day)) q.link.run(rule.id, taskId);
        } else if (repeat && ruleId !== null) {
          const rule = q.rule.get(ruleId, userId);
          const c = ruleColumns(repeat, rule.start_day);
          q.updateRule.run(rule.title, c.freq, c.every, c.mask, c.endDay, rule.remind_at, rule.active, ruleId);
          // Upcoming copies are re-added on the days that match the new repeat, the next time those days are shown.
          q.removeUpcoming.run(ruleId, today, taskId);
        }

        // A change to a task that was already part of a series applies to the series.
        const series = ruleId !== null && ruleId === task.repeating_task_id ? q.rule.get(ruleId, userId) : null;
        if (title !== undefined) {
          q.rename.run(title, taskId);
          if (series) {
            q.updateRule.run(title, series.freq, series.every, series.weekdays, series.end_day, series.remind_at, series.active, ruleId);
            q.renameUpcoming.run(title, ruleId, today);
          }
        }
        if (remindAt !== undefined) {
          q.setRemind.run(remindAt, taskId);
          if (series) {
            const s = q.rule.get(ruleId, userId);
            q.updateRule.run(s.title, s.freq, s.every, s.weekdays, s.end_day, remindAt, s.active, ruleId);
            q.remindUpcoming.run(remindAt, ruleId, today);
          }
        }

        if (priority !== undefined) {
          q.setPriority.run(priority, taskId);
          if (series) {
            q.setRulePriority.run(priority, ruleId);
            q.prioritizeUpcoming.run(priority, ruleId, today);
          }
        }

        if (day !== undefined) q.move.run(day, 'open', userId, day, taskId);
        if (done === true && task.status === 'unfinished') q.move.run(today, 'open', userId, today, taskId);
        if (done === true && task.status !== 'done') q.setStatus.run('done', 'done', taskId);
        if (done === false && task.status === 'done') {
          const status = task.day >= today ? 'open' : repeating ? 'missed' : 'unfinished';
          q.setStatus.run(status, status, taskId);
        }
      });
      return taskJson(q.taskJson.get(taskId));
    },

    /** Deleting a repeating task from today or a later day keeps it from being added back to that day. */
    removeTask(userId, taskId, today) {
      const task = ownedTask(userId, taskId);
      transaction(db, () => {
        if (task.repeating_task_id !== null && task.day >= today) q.skip.run(task.repeating_task_id, task.day);
        q.removeTask.run(taskId);
      });
    },

    /** taskIds: the new order of every task on that day's checklist. */
    reorderDay(userId, day, taskIds, today) {
      const current = dayTasks(userId, day, today).map((t) => t.id);
      if (taskIds.length !== current.length || !current.every((id) => taskIds.includes(id))) {
        throw badRequest("Send the ids of all of that day's tasks, and only those");
      }
      transaction(db, () => taskIds.forEach((id, i) => q.setPosition.run(i, id)));
      return dayTasks(userId, day, today);
    },

    rules: (userId) => q.rules.all(userId).map(ruleJson),

    /** A repeating task on its own (from More): { title, repeat, startDay, remindAt, priority }. */
    addRule(userId, input) {
      return ruleJson(createRule(userId, input));
    },

    /**
     * changes: { title?, repeat?, weekdays?, active?, remindAt?, priority? }. Open copies from today on are updated or removed to
     * match; past days are left as they were.
     */
    updateRule(userId, ruleId, { title, repeat, weekdays, active, remindAt, priority }, today) {
      const rule = ownedRule(userId, ruleId);
      // Only new weekdays: keep the rest of the repeat as it is.
      if (!repeat && weekdays) repeat = { freq: 'weekly', every: rule.every, weekdays, until: rule.end_day };
      const c = repeat ? ruleColumns(repeat, rule.start_day) : { freq: rule.freq, every: rule.every, mask: rule.weekdays, endDay: rule.end_day };
      const next = {
        title: title ?? rule.title,
        active: active === undefined ? rule.active : Number(active),
        remindAt: remindAt === undefined ? rule.remind_at : remindAt,
      };
      const timing = c.freq !== rule.freq || c.every !== rule.every || c.mask !== rule.weekdays || c.endDay !== rule.end_day;
      transaction(db, () => {
        q.updateRule.run(next.title, c.freq, c.every, c.mask, c.endDay, next.remindAt, next.active, ruleId);
        q.renameUpcoming.run(next.title, ruleId, today);
        if (remindAt !== undefined) q.remindUpcoming.run(next.remindAt, ruleId, today);
        if (priority !== undefined) {
          q.setRulePriority.run(priority, ruleId);
          q.prioritizeUpcoming.run(priority, ruleId, today);
        }
        // Simplest correct way to apply a new repeat or a pause: drop the upcoming open copies;
        // they're added back on the days that still match the next time those days are looked at.
        if (timing || next.active !== rule.active) q.removeUpcoming.run(ruleId, today, -1);
      });
      return ruleJson(ownedRule(userId, ruleId));
    },

    /** Removes the rule and its open copies from today on. Finished copies stay until the weekly clean-up. */
    removeRule(userId, ruleId, today) {
      ownedRule(userId, ruleId);
      transaction(db, () => {
        q.removeUpcoming.run(ruleId, today, -1);
        q.removeRule.run(ruleId);
      });
    },
  };
}
