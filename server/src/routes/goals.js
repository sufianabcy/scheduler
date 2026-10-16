import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { badRequest } from '../http.js';
import { createGoals } from '../goals.js';
import { monthOf } from '../time.js';
import * as v from '../validate.js';

/** dueDay in a body: undefined = not sent, null = no date, otherwise 'YYYY-MM-DD'. */
const dueDay = (value, field) => (value === undefined || value === null ? value : v.day(value, field));

/** { title, dueDay? } from a request body. */
function taskInput(value, field) {
  if (typeof value !== 'object' || value === null) throw badRequest(`${field} must be an object`);
  return { title: v.title(value.title, `${field}.title`), dueDay: dueDay(value.dueDay, `${field}.dueDay`) ?? null };
}

export function goalRoutes({ db, now }) {
  const goals = createGoals(db);
  const router = Router();
  router.use(requireAuth);

  const ids = (req) => ({
    goalId: v.pathId(req.params.id),
    taskId: req.params.taskId === undefined ? undefined : v.pathId(req.params.taskId),
  });
  const body = (req) => req.body ?? {};

  // ?month=YYYY-MM, default this month (IST).
  router.get('/', (req, res) => {
    const month = req.query.month === undefined ? monthOf(now()) : v.month(req.query.month);
    res.json({ month, goals: goals.list(req.user.id, month) });
  });

  // Body: { title, month?, tasks?: [{ title, dueDay? }] }
  router.post('/', (req, res) => {
    const b = body(req);
    const month = b.month === undefined ? monthOf(now()) : v.month(b.month);
    const tasks = v.list(b.tasks, 'tasks', taskInput);
    res.status(201).json(goals.create(req.user.id, v.title(b.title), month, tasks));
  });

  router.get('/:id', (req, res) => {
    res.json(goals.detail(req.user.id, ids(req).goalId));
  });

  router.patch('/:id', (req, res) => {
    res.json(goals.rename(req.user.id, ids(req).goalId, v.title(body(req).title)));
  });

  router.delete('/:id', (req, res) => {
    goals.remove(req.user.id, ids(req).goalId);
    res.status(204).end();
  });

  // Body: { title, dueDay?, beforeTaskId? }. Without beforeTaskId the task goes last.
  router.post('/:id/tasks', (req, res) => {
    const b = body(req);
    const task = taskInput(b, 'task');
    const before = v.optionalId(b.beforeTaskId, 'beforeTaskId');
    res.status(201).json(goals.addTask(req.user.id, ids(req).goalId, task, before));
  });

  // Body: { taskIds: [...] } — the new order of all unfinished tasks.
  router.put('/:id/tasks/order', (req, res) => {
    const taskIds = v.idList(body(req).taskIds, 'taskIds');
    res.json(goals.reorderTasks(req.user.id, ids(req).goalId, taskIds));
  });

  // Body: { title?, dueDay? }
  router.patch('/:id/tasks/:taskId', (req, res) => {
    const { goalId, taskId } = ids(req);
    const b = body(req);
    if (b.title === undefined && b.dueDay === undefined) throw badRequest('Send title or dueDay');
    const changes = {
      title: b.title === undefined ? undefined : v.title(b.title),
      dueDay: dueDay(b.dueDay, 'dueDay'),
    };
    res.json(goals.updateTask(req.user.id, goalId, taskId, changes));
  });

  router.delete('/:id/tasks/:taskId', (req, res) => {
    const { goalId, taskId } = ids(req);
    res.json(goals.removeTask(req.user.id, goalId, taskId));
  });

  router.post('/:id/tasks/:taskId/finish', (req, res) => {
    const { goalId, taskId } = ids(req);
    res.json(goals.finishTask(req.user.id, goalId, taskId));
  });

  router.post('/:id/tasks/:taskId/reopen', (req, res) => {
    const { goalId, taskId } = ids(req);
    res.json(goals.reopenTask(req.user.id, goalId, taskId));
  });

  return router;
}
