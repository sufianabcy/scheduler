import { transaction } from './db.js';
import { badRequest, conflict, notFound } from './http.js';
import { weekdayIndex } from './time.js';

// Repeating tasks store their weekdays as a bitmask (Mon = 1 … Sun = 64); the API uses day names.
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const maskOf = (names) => names.reduce((mask, name) => mask | (1 << WEEKDAYS.indexOf(name)), 0);
export const namesOf = (mask) => WEEKDAYS.filter((_, i) => mask & (1 << i));

const taskJson = (t) => ({
  id: t.id,
  title: t.title,
  day: t.day,
  status: t.status,
  repeating: t.repeating_task_id !== null,
  doneAt: t.done_at,
});

const ruleJson = (r) => ({ id: r.id, title: r.title, weekdays: namesOf(r.weekdays), active: r.active === 1 });

/**
 * The daily plan: one checklist per day, repeating tasks, and the Unfinished list.
 * `today` is passed in by the caller (IST), so the rules can be tested with any date.
 *
 * Statuses: open → done when ticked. At midnight an open task from an earlier day becomes unfinished
 * (or missed, for a repeating task); see jobs.js.
 */
export function createDaily(db) {
  const q = {
    task: db.prepare('SELECT * FROM daily_tasks WHERE id = ? AND user_id = ?'),
    // A day's checklist. Unfinished tasks keep their old day but are shown in the Unfinished list instead.
    dayTasks: db.prepare(`
      SELECT * FROM daily_tasks
      WHERE user_id = ? AND day = ? AND status != 'unfinished'
      ORDER BY position, id`),
    unfinished: db.prepare(`
      SELECT * FROM daily_tasks WHERE user_id = ? AND status = 'unfinished' ORDER BY day, position, id`),
    insertTask: db.prepare(`
      INSERT INTO daily_tasks (user_id, title, day, position)
      VALUES (?, ?, ?, (SELECT coalesce(max(position), -1) + 1 FROM daily_tasks WHERE user_id = ? AND day = ?))`),
    rename: db.prepare('UPDATE daily_tasks SET title = ? WHERE id = ?'),
    setStatus: db.prepare(`
      UPDATE daily_tasks
      SET status = ?, done_at = CASE WHEN ? = 'done' THEN datetime('now') ELSE NULL END
      WHERE id = ?`),
    move: db.prepare(`
      UPDATE daily_tasks
      SET day = ?, status = ?, position = (SELECT coalesce(max(position), -1) + 1 FROM daily_tasks WHERE user_id = ? AND day = ?)
      WHERE id = ?`),
    setPosition: db.prepare('UPDATE daily_tasks SET position = ? WHERE id = ?'),
    removeTask: db.prepare('DELETE FROM daily_tasks WHERE id = ?'),

    rules: db.prepare('SELECT * FROM repeating_tasks WHERE user_id = ? ORDER BY id'),
    rule: db.prepare('SELECT * FROM repeating_tasks WHERE id = ? AND user_id = ?'),
    insertRule: db.prepare('INSERT INTO repeating_tasks (user_id, title, weekdays) VALUES (?, ?, ?)'),
    updateRule: db.prepare('UPDATE repeating_tasks SET title = ?, weekdays = ?, active = ? WHERE id = ?'),
    removeRule: db.prepare('DELETE FROM repeating_tasks WHERE id = ?'),
    // Repeating tasks are added to a day the first time that day (today or later) is looked at.
    // They go first (position -1). The unique index makes this a no-op once added.
    generate: db.prepare(`
      INSERT OR IGNORE INTO daily_tasks (user_id, title, day, repeating_task_id, position)
      SELECT r.user_id, r.title, ?, r.id, -1
      FROM repeating_tasks r
      WHERE r.user_id = ? AND r.active = 1 AND (r.weekdays & ?) != 0
        AND NOT EXISTS (SELECT 1 FROM repeat_skips s WHERE s.repeating_task_id = r.id AND s.day = ?)`),
    renameUpcoming: db.prepare(`
      UPDATE daily_tasks SET title = ? WHERE repeating_task_id = ? AND status = 'open' AND day >= ?`),
    removeUpcoming: db.prepare(`
      DELETE FROM daily_tasks WHERE repeating_task_id = ? AND status = 'open' AND day >= ?`),
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

  function dayTasks(userId, day, today) {
    if (day >= today) q.generate.run(day, userId, 1 << weekdayIndex(day), day);
    return q.dayTasks.all(userId, day).map(taskJson);
  }

  function noPastDay(day, today) {
    if (day < today) throw badRequest("Past days can't be planned");
  }

  return {
    dayTasks,

    unfinished: (userId) => q.unfinished.all(userId).map(taskJson),

    addTask(userId, day, title, today) {
      noPastDay(day, today);
      q.insertTask.run(userId, title, day, userId, day);
      return dayTasks(userId, day, today);
    },

    /**
     * changes: { title?, done?, day? } — `done` and `day` can't be sent together.
     * - done: true ticks an open or unfinished task. Ticking from the Unfinished list moves it to today, so it
     *   shows on the day it was finished.
     * - done: false unticks; a task from an earlier day goes back to unfinished (or missed if repeating).
     * - day moves an open or unfinished task to that day (today or later). Repeating tasks can't be moved.
     */
    updateTask(userId, taskId, { title, done, day }, today) {
      const task = ownedTask(userId, taskId);
      const repeating = task.repeating_task_id !== null;

      if (done === true && task.status === 'missed') throw conflict("A missed task from an earlier day can't be ticked");
      if (day !== undefined) {
        if (repeating) throw conflict("Repeating tasks can't be moved to another day; delete this one instead");
        if (task.status === 'done' || task.status === 'missed') throw conflict('Only unfinished tasks can be moved');
        noPastDay(day, today);
      }

      transaction(db, () => {
        if (title !== undefined) q.rename.run(title, taskId);
        if (day !== undefined) q.move.run(day, 'open', userId, day, taskId);
        if (done === true && task.status === 'unfinished') q.move.run(today, 'open', userId, today, taskId);
        if (done === true && task.status !== 'done') q.setStatus.run('done', 'done', taskId);
        if (done === false && task.status === 'done') {
          const status = task.day >= today ? 'open' : repeating ? 'missed' : 'unfinished';
          q.setStatus.run(status, status, taskId);
        }
      });
      return taskJson(ownedTask(userId, taskId));
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

    addRule(userId, title, weekdays) {
      const { lastInsertRowid } = q.insertRule.run(userId, title, maskOf(weekdays));
      return ruleJson(ownedRule(userId, Number(lastInsertRowid)));
    },

    /**
     * changes: { title?, weekdays?, active? }. Open copies on today and later days are updated or removed to match;
     * past days are left as they were.
     */
    updateRule(userId, ruleId, { title, weekdays, active }, today) {
      const rule = ownedRule(userId, ruleId);
      const next = {
        title: title ?? rule.title,
        mask: weekdays === undefined ? rule.weekdays : maskOf(weekdays),
        active: active === undefined ? rule.active : Number(active),
      };
      transaction(db, () => {
        q.updateRule.run(next.title, next.mask, next.active, ruleId);
        q.renameUpcoming.run(next.title, ruleId, today);
        // Simplest correct way to apply new weekdays or a pause: drop the upcoming open copies;
        // they're added back on the days that still match the next time those days are looked at.
        if (next.mask !== rule.weekdays || next.active !== rule.active) q.removeUpcoming.run(ruleId, today);
      });
      return ruleJson(ownedRule(userId, ruleId));
    },

    /** Removes the rule and its open copies from today on. Finished copies stay until the weekly clean-up. */
    removeRule(userId, ruleId, today) {
      ownedRule(userId, ruleId);
      transaction(db, () => {
        q.removeUpcoming.run(ruleId, today);
        q.removeRule.run(ruleId);
      });
    },
  };
}
