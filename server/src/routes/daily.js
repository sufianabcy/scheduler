import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { WEEKDAYS, createDaily } from '../daily.js';
import { createGoals } from '../goals.js';
import { badRequest } from '../http.js';
import { createProjects } from '../projects.js';
import { dayOf, monthOf } from '../time.js';
import * as v from '../validate.js';

function weekdays(value) {
  const names = v.list(value, 'weekdays', (name, field) => {
    if (!WEEKDAYS.includes(name)) throw badRequest(`${field} must be one of ${WEEKDAYS.join(', ')}`);
    return name;
  });
  if (names.length === 0) throw badRequest('Pick at least one weekday');
  return names;
}

/** Daily plan, Unfinished list, repeating tasks, and /today for the home page. */
export function dailyRoutes({ db, now }) {
  const daily = createDaily(db);
  const goals = createGoals(db);
  const projects = createProjects(db);
  const router = Router();

  const ready = [
    requireAuth,
    (req, res, next) => {
      req.today = dayOf(now());
      next();
    },
  ];
  const body = (req) => req.body ?? {};

  /**
   * Everything the home page needs in one request: today's checklist, the Unfinished list, goal tasks due today
   * (or overdue), and the goal and project cards.
   */
  router.get('/today', ready, (req, res) => {
    const userId = req.user.id;
    const month = monthOf(now());
    res.json({
      day: req.today,
      month,
      tasks: daily.dayTasks(userId, req.today, req.today),
      unfinished: daily.unfinished(userId),
      goalTasksDue: goals.dueTasks(userId, month, req.today),
      goals: goals.list(userId, month),
      projects: projects.list(userId),
    });
  });

  router.get('/days/:day', ready, (req, res) => {
    const day = v.day(req.params.day);
    res.json({ day, tasks: daily.dayTasks(req.user.id, day, req.today) });
  });

  router.post('/days/:day/tasks', ready, (req, res) => {
    const day = v.day(req.params.day);
    const tasks = daily.addTask(req.user.id, day, v.title(body(req).title), req.today);
    res.status(201).json({ day, tasks });
  });

  // Body: { taskIds } — the new order of every task on that day.
  router.put('/days/:day/order', ready, (req, res) => {
    const day = v.day(req.params.day);
    const tasks = daily.reorderDay(req.user.id, day, v.idList(body(req).taskIds, 'taskIds'), req.today);
    res.json({ day, tasks });
  });

  // Body: { title?, done?, day? } — see createDaily().updateTask for the rules.
  router.patch('/tasks/:id', ready, (req, res) => {
    const b = body(req);
    if (b.title === undefined && b.done === undefined && b.day === undefined) {
      throw badRequest('Send title, done or day');
    }
    if (b.done !== undefined && b.day !== undefined) throw badRequest('Send done or day, not both');
    const changes = {
      title: b.title === undefined ? undefined : v.title(b.title),
      done: b.done === undefined ? undefined : v.boolean(b.done, 'done'),
      day: b.day === undefined ? undefined : v.day(b.day),
    };
    res.json(daily.updateTask(req.user.id, v.pathId(req.params.id), changes, req.today));
  });

  router.delete('/tasks/:id', ready, (req, res) => {
    daily.removeTask(req.user.id, v.pathId(req.params.id), req.today);
    res.status(204).end();
  });

  router.get('/unfinished', ready, (req, res) => {
    res.json({ tasks: daily.unfinished(req.user.id) });
  });

  router.get('/repeating', ready, (req, res) => {
    res.json({ weekdays: WEEKDAYS, rules: daily.rules(req.user.id) });
  });

  // Body: { title, weekdays: ['mon', …] }
  router.post('/repeating', ready, (req, res) => {
    const b = body(req);
    res.status(201).json(daily.addRule(req.user.id, v.title(b.title), weekdays(b.weekdays)));
  });

  // Body: { title?, weekdays?, active? } — active: false pauses it.
  router.patch('/repeating/:id', ready, (req, res) => {
    const b = body(req);
    if (b.title === undefined && b.weekdays === undefined && b.active === undefined) {
      throw badRequest('Send title, weekdays or active');
    }
    const changes = {
      title: b.title === undefined ? undefined : v.title(b.title),
      weekdays: b.weekdays === undefined ? undefined : weekdays(b.weekdays),
      active: b.active === undefined ? undefined : v.boolean(b.active, 'active'),
    };
    res.json(daily.updateRule(req.user.id, v.pathId(req.params.id), changes, req.today));
  });

  router.delete('/repeating/:id', ready, (req, res) => {
    daily.removeRule(req.user.id, v.pathId(req.params.id), req.today);
    res.status(204).end();
  });

  return router;
}
