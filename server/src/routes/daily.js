import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { FREQS, WEEKDAYS, createDaily } from '../daily.js';
import { createGoals } from '../goals.js';
import { badRequest } from '../http.js';
import { createProjects } from '../projects.js';
import { dayOf, monthOf } from '../time.js';
import * as v from '../validate.js';

function weekdays(value, field = 'weekdays', { allowEmpty = false } = {}) {
  const names = v.list(value, field, (name, f) => {
    if (!WEEKDAYS.includes(name)) throw badRequest(`${f} must be one of ${WEEKDAYS.join(', ')}`);
    return name;
  });
  if (names.length === 0 && !allowEmpty) throw badRequest('Pick at least one weekday');
  return [...new Set(names)];
}

/**
 * repeat in a body: undefined = not sent, null = doesn't repeat, or
 * { freq: 'daily' | 'weekly' | 'monthly', every?: 1–99, weekdays?: ['mon', …] (weekly), until?: 'YYYY-MM-DD' | null }.
 */
function repeatInput(value) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'object' || Array.isArray(value)) throw badRequest('repeat must be an object or null');
  if (!FREQS.includes(value.freq)) throw badRequest(`repeat.freq must be one of ${FREQS.join(', ')}`);
  const every = value.every ?? 1;
  if (!Number.isInteger(every) || every < 1 || every > 99) throw badRequest('repeat.every must be a whole number from 1 to 99');
  return {
    freq: value.freq,
    every,
    weekdays: value.freq === 'weekly' ? weekdays(value.weekdays, 'repeat.weekdays', { allowEmpty: true }) : [],
    until: value.until === undefined || value.until === null ? null : v.day(value.until, 'repeat.until'),
  };
}

/** priority in a body: undefined = not sent, null = none, or 1–3 (1 is highest). */
function priorityInput(value) {
  if (value === undefined || value === null) return value;
  if (![1, 2, 3].includes(value)) throw badRequest('priority must be 1, 2, 3 or null');
  return value;
}

/** remindAt in a body: undefined = not sent, null = no reminder, or 'HH:MM'. */
const remindInput = (value) => (value === undefined || value === null ? value : v.time(value, 'remindAt'));

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

  // Body: { title, repeat?, remindAt?, priority? }. Answers { day, tasks, firstDay } — firstDay is when a repeating
  // task first happens (later than `day` if its weekdays skip it).
  router.post('/days/:day/tasks', ready, (req, res) => {
    const day = v.day(req.params.day);
    const b = body(req);
    const input = {
      title: v.title(b.title),
      repeat: repeatInput(b.repeat) ?? null,
      remindAt: remindInput(b.remindAt) ?? null,
      priority: priorityInput(b.priority) ?? null,
    };
    res.status(201).json({ day, ...daily.addTask(req.user.id, day, input, req.today) });
  });

  // Body: { taskIds } — the new order of every task on that day.
  router.put('/days/:day/order', ready, (req, res) => {
    const day = v.day(req.params.day);
    const tasks = daily.reorderDay(req.user.id, day, v.idList(body(req).taskIds, 'taskIds'), req.today);
    res.json({ day, tasks });
  });

  // Body: { title?, done?, day?, repeat?, remindAt?, priority? } — see createDaily().updateTask for the rules.
  router.patch('/tasks/:id', ready, (req, res) => {
    const b = body(req);
    const fields = ['title', 'done', 'day', 'repeat', 'remindAt', 'priority'];
    if (fields.every((f) => b[f] === undefined)) throw badRequest(`Send one of ${fields.join(', ')}`);
    if (b.done !== undefined && b.day !== undefined) throw badRequest('Send done or day, not both');
    const changes = {
      title: b.title === undefined ? undefined : v.title(b.title),
      done: b.done === undefined ? undefined : v.boolean(b.done, 'done'),
      day: b.day === undefined ? undefined : v.day(b.day),
      repeat: repeatInput(b.repeat),
      remindAt: remindInput(b.remindAt),
      priority: priorityInput(b.priority),
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

  // Body: { title, repeat, startDay?, remindAt?, priority? }, or the short form { title, weekdays } for weekly.
  router.post('/repeating', ready, (req, res) => {
    const b = body(req);
    const repeat = b.repeat === undefined ? { freq: 'weekly', every: 1, weekdays: weekdays(b.weekdays), until: null } : repeatInput(b.repeat);
    if (!repeat) throw badRequest('repeat is required');
    const input = {
      title: v.title(b.title),
      repeat,
      startDay: b.startDay === undefined ? req.today : v.day(b.startDay, 'startDay'),
      remindAt: remindInput(b.remindAt) ?? null,
      priority: priorityInput(b.priority) ?? null,
    };
    res.status(201).json(daily.addRule(req.user.id, input));
  });

  // Body: { title?, repeat?, weekdays?, active?, remindAt?, priority? } — active: false pauses it.
  router.patch('/repeating/:id', ready, (req, res) => {
    const b = body(req);
    const fields = ['title', 'repeat', 'weekdays', 'active', 'remindAt', 'priority'];
    if (fields.every((f) => b[f] === undefined)) throw badRequest(`Send one of ${fields.join(', ')}`);
    if (b.repeat === null) throw badRequest('To stop repeating, delete the repeating task');
    const changes = {
      title: b.title === undefined ? undefined : v.title(b.title),
      repeat: repeatInput(b.repeat),
      weekdays: b.weekdays === undefined ? undefined : weekdays(b.weekdays),
      active: b.active === undefined ? undefined : v.boolean(b.active, 'active'),
      remindAt: remindInput(b.remindAt),
      priority: priorityInput(b.priority),
    };
    res.json(daily.updateRule(req.user.id, v.pathId(req.params.id), changes, req.today));
  });

  router.delete('/repeating/:id', ready, (req, res) => {
    daily.removeRule(req.user.id, v.pathId(req.params.id), req.today);
    res.status(204).end();
  });

  return router;
}
