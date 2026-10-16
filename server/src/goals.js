import { transaction } from './db.js';
import { conflict, notFound } from './http.js';
import { orderedList } from './orderedList.js';

/** Monthly goals: a list of tasks done in order, like project steps. Every method checks ownership. */
export function createGoals(db) {
  const tasks = orderedList(db, { table: 'goal_tasks', parentCol: 'goal_id', noun: 'task' });

  const q = {
    owned: db.prepare('SELECT id, title, month, carried_from, created_at FROM monthly_goals WHERE id = ? AND user_id = ?'),
    ofMonth: db.prepare('SELECT id FROM monthly_goals WHERE user_id = ? AND month = ? ORDER BY position, id'),
    insert: db.prepare(`
      INSERT INTO monthly_goals (user_id, title, month, position)
      VALUES (?, ?, ?, (SELECT coalesce(max(position), -1) + 1 FROM monthly_goals WHERE user_id = ? AND month = ?))`),
    rename: db.prepare('UPDATE monthly_goals SET title = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM monthly_goals WHERE id = ?'),
    insertTask: db.prepare('INSERT INTO goal_tasks (goal_id, title, position, due_day) VALUES (?, ?, ?, ?)'),
    renameTask: db.prepare('UPDATE goal_tasks SET title = ? WHERE id = ?'),
    setDueDay: db.prepare('UPDATE goal_tasks SET due_day = ? WHERE id = ?'),
  };

  function owned(userId, goalId) {
    const goal = q.owned.get(goalId, userId);
    if (!goal) throw notFound('No such goal');
    return goal;
  }

  function detail(userId, goalId) {
    const goal = owned(userId, goalId);
    const list = tasks.withState(tasks.rows(goal.id)).map((t) => ({
      id: t.id,
      title: t.title,
      state: t.state,
      dueDay: t.due_day,
      doneAt: t.done_at,
    }));
    const tasksDone = list.filter((t) => t.state === 'done').length;
    const current = list.find((t) => t.state === 'current') ?? null;
    return {
      id: goal.id,
      title: goal.title,
      month: goal.month,
      carriedFrom: goal.carried_from,
      createdAt: goal.created_at,
      progress: list.length === 0 ? 0 : Math.floor((tasksDone / list.length) * 100),
      done: list.length > 0 && current === null,
      tasksDone,
      tasksTotal: list.length,
      currentTaskId: current?.id ?? null,
      tasks: list,
    };
  }

  const change = (userId, goalId, fn) => {
    transaction(db, fn);
    return detail(userId, goalId);
  };

  return {
    detail,

    list(userId, month) {
      return q.ofMonth.all(userId, month).map(({ id }) => {
        const d = detail(userId, id);
        const current = d.tasks.find((t) => t.id === d.currentTaskId);
        return {
          id: d.id,
          title: d.title,
          month: d.month,
          carriedFrom: d.carriedFrom,
          progress: d.progress,
          done: d.done,
          tasksDone: d.tasksDone,
          tasksTotal: d.tasksTotal,
          currentTask: current ? { id: current.id, title: current.title, dueDay: current.dueDay } : null,
        };
      });
    },

    /** taskInputs: [{ title, dueDay: 'YYYY-MM-DD' | null }] */
    create(userId, title, month, taskInputs) {
      const goalId = transaction(db, () => {
        const id = Number(q.insert.run(userId, title, month, userId, month).lastInsertRowid);
        taskInputs.forEach((t, i) => q.insertTask.run(id, t.title, i, t.dueDay));
        return id;
      });
      return detail(userId, goalId);
    },

    rename(userId, goalId, title) {
      owned(userId, goalId);
      return change(userId, goalId, () => q.rename.run(title, goalId));
    },

    remove(userId, goalId) {
      owned(userId, goalId);
      q.remove.run(goalId);
    },

    addTask(userId, goalId, { title, dueDay }, beforeTaskId) {
      owned(userId, goalId);
      return change(userId, goalId, () => {
        const taskId = Number(q.insertTask.run(goalId, title, Number.MAX_SAFE_INTEGER, dueDay).lastInsertRowid);
        tasks.place(goalId, taskId, beforeTaskId);
      });
    },

    /** changes: { title?, dueDay? } — dueDay null removes the date. Only unfinished tasks can change date. */
    updateTask(userId, goalId, taskId, { title, dueDay }) {
      owned(userId, goalId);
      const task = tasks.find(goalId, taskId);
      if (dueDay !== undefined && task.state === 'done') throw conflict("A finished task's date can't change");
      return change(userId, goalId, () => {
        if (title !== undefined) q.renameTask.run(title, taskId);
        if (dueDay !== undefined) q.setDueDay.run(dueDay, taskId);
      });
    },

    removeTask(userId, goalId, taskId) {
      owned(userId, goalId);
      return change(userId, goalId, () => tasks.remove(goalId, taskId));
    },

    reorderTasks(userId, goalId, taskIds) {
      owned(userId, goalId);
      return change(userId, goalId, () => tasks.reorder(goalId, taskIds));
    },

    finishTask(userId, goalId, taskId) {
      owned(userId, goalId);
      return change(userId, goalId, () => tasks.finish(goalId, taskId));
    },

    reopenTask(userId, goalId, taskId) {
      owned(userId, goalId);
      return change(userId, goalId, () => tasks.reopen(goalId, taskId));
    },
  };
}
