import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { addDays, dayOf, weekStart, weekdayIndex } from '../src/time.js';
import { loggedIn, startTestServer } from './helpers.js';

// Calendar used below: 2026-10-12 is a Monday, 2026-10-15 a Thursday, 2026-10-18 a Sunday.
/** A moment on that day, IST. */
const at = (day, time = '12:00') => new Date(`${day}T${time}:00+05:30`);

describe('date helpers', () => {
  test('days roll over at midnight IST, not UTC', () => {
    assert.equal(dayOf(new Date('2026-10-15T18:29:00Z')), '2026-10-15'); // 23:59 IST
    assert.equal(dayOf(new Date('2026-10-15T18:30:00Z')), '2026-10-16'); // 00:00 IST
  });

  test('addDays, weekdayIndex and weekStart', () => {
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(weekdayIndex('2026-10-12'), 0);
    assert.equal(weekdayIndex('2026-10-18'), 6);
    assert.equal(weekStart('2026-10-18'), '2026-10-12');
    assert.equal(weekStart('2026-10-12'), '2026-10-12');
  });
});

describe('daily plan API', () => {
  let t, api, other, clock;
  const setup = async (day, time) => {
    clock = at(day, time);
    t = await startTestServer({ now: () => clock });
    api = await loggedIn(t, 'peter@example.test');
    other = await loggedIn(t, 'miles@example.test');
  };
  afterEach(() => t.close());

  const titles = (tasks) => tasks.map((x) => x.title);
  const addTask = async (day, title) => {
    const res = await api('POST', `/api/days/${day}/tasks`, { title });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.tasks.find((x) => x.title === title);
  };
  const dayView = async (day) => (await api('GET', `/api/days/${day}`)).body.tasks;
  const today = async () => (await api('GET', '/api/today')).body;

  test('plan a day, tick and untick tasks', async () => {
    await setup('2026-10-15');
    const a = await addTask('2026-10-15', 'Email Ravi');
    await addTask('2026-10-15', 'Pay rent');
    await addTask('2026-10-16', 'Plan tomorrow');

    let view = await today();
    assert.equal(view.day, '2026-10-15');
    assert.deepEqual(titles(view.tasks), ['Email Ravi', 'Pay rent']);
    assert.equal(view.tasks[0].status, 'open');

    let res = await api('PATCH', `/api/tasks/${a.id}`, { done: true });
    assert.equal(res.body.status, 'done');
    assert.ok(res.body.doneAt);
    res = await api('PATCH', `/api/tasks/${a.id}`, { done: false });
    assert.equal(res.body.status, 'open');
    assert.equal(res.body.doneAt, null);

    assert.deepEqual(titles(await dayView('2026-10-16')), ['Plan tomorrow']);
  });

  test("past days can't be planned", async () => {
    await setup('2026-10-15');
    const res = await api('POST', '/api/days/2026-10-14/tasks', { title: 'Too late' });
    assert.equal(res.status, 400);
  });

  test('at midnight, unticked tasks go to Unfinished, not to the next day', async () => {
    await setup('2026-10-15', '22:00');
    const open = await addTask('2026-10-15', 'Read chapter 3');
    const done = await addTask('2026-10-15', 'Gym shoes');
    await api('PATCH', `/api/tasks/${done.id}`, { done: true });

    clock = at('2026-10-16', '00:01');
    const view = await today();
    assert.deepEqual(view.tasks, []);
    assert.deepEqual(view.unfinished.map((x) => [x.id, x.day, x.status]), [[open.id, '2026-10-15', 'unfinished']]);

    // The finished task still shows on its own day.
    assert.deepEqual((await dayView('2026-10-15')).map((x) => [x.title, x.status]), [['Gym shoes', 'done']]);
  });

  test('ticking an Unfinished task moves it to today as done', async () => {
    await setup('2026-10-15');
    const task = await addTask('2026-10-15', 'Call bank');
    clock = at('2026-10-17');

    let res = await api('PATCH', `/api/tasks/${task.id}`, { done: true });
    assert.equal(res.body.status, 'done');
    assert.equal(res.body.day, '2026-10-17');
    let view = await today();
    assert.deepEqual(view.unfinished, []);
    assert.deepEqual(titles(view.tasks), ['Call bank']);

    res = await api('PATCH', `/api/tasks/${task.id}`, { done: false });
    assert.equal(res.body.status, 'open');
  });

  test('an Unfinished task can be moved to today or a later day, not the past', async () => {
    await setup('2026-10-15');
    const task = await addTask('2026-10-15', 'Renew passport');
    clock = at('2026-10-16');

    assert.equal((await api('PATCH', `/api/tasks/${task.id}`, { day: '2026-10-15' })).status, 400);
    const res = await api('PATCH', `/api/tasks/${task.id}`, { day: '2026-10-19' });
    assert.equal(res.body.status, 'open');
    assert.equal(res.body.day, '2026-10-19');
    assert.deepEqual((await today()).unfinished, []);
    assert.deepEqual(titles(await dayView('2026-10-19')), ['Renew passport']);
  });

  test('unticking a task from an earlier day sends it to Unfinished', async () => {
    await setup('2026-10-15');
    const task = await addTask('2026-10-15', 'Laundry');
    await api('PATCH', `/api/tasks/${task.id}`, { done: true });
    clock = at('2026-10-16');
    const res = await api('PATCH', `/api/tasks/${task.id}`, { done: false });
    assert.equal(res.body.status, 'unfinished');
    assert.equal((await today()).unfinished.length, 1);
  });

  test('repeating tasks appear on their weekdays, first in the list', async () => {
    await setup('2026-10-15');
    await addTask('2026-10-15', 'Standup notes');
    const rule = (await api('POST', '/api/repeating', { title: 'Gym', weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'] })).body;
    assert.deepEqual(rule.weekdays, ['mon', 'tue', 'wed', 'thu', 'fri']);
    assert.equal(rule.active, true);

    const view = await today();
    assert.deepEqual(titles(view.tasks), ['Gym', 'Standup notes']);
    assert.equal(view.tasks[0].repeating, true);
    assert.deepEqual(await dayView('2026-10-17'), []); // Saturday
    assert.deepEqual(titles(await dayView('2026-10-19')), ['Gym']); // Monday
    assert.deepEqual(titles(await dayView('2026-10-19')), ['Gym'], 'added only once');
    assert.deepEqual(await dayView('2026-10-14'), [], 'not added to past days');
  });

  test('a missed repeating task is marked missed and does not go to Unfinished', async () => {
    await setup('2026-10-15');
    await api('POST', '/api/repeating', { title: 'Meditate', weekdays: ['thu'] });
    const gym = (await today()).tasks[0];

    clock = at('2026-10-16');
    const view = await today();
    assert.deepEqual(view.unfinished, []);
    assert.equal((await dayView('2026-10-15'))[0].status, 'missed');
    assert.equal((await api('PATCH', `/api/tasks/${gym.id}`, { done: true })).status, 409);
  });

  test('deleting a repeating task from a day keeps it off that day only', async () => {
    await setup('2026-10-15');
    await api('POST', '/api/repeating', { title: 'Gym', weekdays: ['thu', 'fri'] });
    const gym = (await today()).tasks[0];

    assert.equal((await api('PATCH', `/api/tasks/${gym.id}`, { day: '2026-10-16' })).status, 409);
    assert.equal((await api('DELETE', `/api/tasks/${gym.id}`)).status, 204);
    assert.deepEqual((await today()).tasks, []);
    assert.deepEqual(titles(await dayView('2026-10-16')), ['Gym']);
  });

  test('changing a rule updates upcoming copies but leaves past days alone', async () => {
    await setup('2026-10-15');
    const rule = (await api('POST', '/api/repeating', { title: 'Gym', weekdays: ['wed', 'thu', 'mon'] })).body;
    await today();
    await dayView('2026-10-19');

    // A copy on an earlier day (Wednesday) that was ticked.
    const past = t.db
      .prepare("INSERT INTO daily_tasks (user_id, title, day, status, repeating_task_id) SELECT user_id, 'Gym', '2026-10-14', 'done', id FROM repeating_tasks")
      .run().lastInsertRowid;

    let res = await api('PATCH', `/api/repeating/${rule.id}`, { title: 'Gym (legs)', weekdays: ['sat'] });
    assert.deepEqual(res.body.weekdays, ['sat']);
    assert.deepEqual(await dayView('2026-10-15'), []);
    assert.deepEqual(await dayView('2026-10-19'), []);
    assert.deepEqual(titles(await dayView('2026-10-17')), ['Gym (legs)']);
    assert.deepEqual((await dayView('2026-10-14')).map((x) => [x.id, x.title]), [[Number(past), 'Gym']]);

    res = await api('PATCH', `/api/repeating/${rule.id}`, { active: false });
    assert.equal(res.body.active, false);
    assert.deepEqual(await dayView('2026-10-17'), []);

    await api('PATCH', `/api/repeating/${rule.id}`, { active: true });
    assert.deepEqual(titles(await dayView('2026-10-17')), ['Gym (legs)']);

    assert.equal((await api('DELETE', `/api/repeating/${rule.id}`)).status, 204);
    assert.deepEqual(await dayView('2026-10-17'), []);
    assert.deepEqual((await api('GET', '/api/repeating')).body.rules, []);
    assert.equal((await dayView('2026-10-14')).length, 1, 'past copy is kept');
  });

  test('finished and missed tasks are deleted when their week ends; Unfinished ones stay', async () => {
    await setup('2026-10-15');
    await api('POST', '/api/repeating', { title: 'Gym', weekdays: ['thu'] });
    await today();
    const done = await addTask('2026-10-15', 'Done thing');
    await api('PATCH', `/api/tasks/${done.id}`, { done: true });
    await addTask('2026-10-15', 'Left open');
    const sunday = await addTask('2026-10-18', 'Sunday chore');

    clock = at('2026-10-18');
    await api('PATCH', `/api/tasks/${sunday.id}`, { done: true });
    assert.equal((await dayView('2026-10-15')).length, 2, 'still this week');

    clock = at('2026-10-19', '00:01'); // Monday: last week is over
    assert.deepEqual(await dayView('2026-10-15'), []);
    assert.deepEqual(await dayView('2026-10-18'), []);
    assert.deepEqual(titles((await today()).unfinished), ['Left open']);
  });

  test('a dated monthly-goal task that is not done moves to the next day and shows on /today', async () => {
    await setup('2026-10-15');
    const goal = (
      await api('POST', '/api/goals', { title: 'Fitness', tasks: [{ title: 'Book trainer', dueDay: '2026-10-15' }, { title: 'Week 1' }] })
    ).body;

    let view = await today();
    assert.deepEqual(view.goalTasksDue, [
      { goalId: goal.id, goalTitle: 'Fitness', taskId: goal.tasks[0].id, title: 'Book trainer', dueDay: '2026-10-15', state: 'current' },
    ]);

    clock = at('2026-10-16');
    view = await today();
    assert.equal(view.goalTasksDue[0].dueDay, '2026-10-16');

    await api('POST', `/api/goals/${goal.id}/tasks/${goal.tasks[0].id}/finish`);
    assert.deepEqual((await today()).goalTasksDue, []);
  });

  test('at month end, finished goals are deleted and unfinished ones move to the new month', async () => {
    await setup('2026-10-30');
    const create = async (title, tasks) => (await api('POST', '/api/goals', { title, tasks })).body;
    const partial = await create('Learn Spring', [{ title: 'A' }, { title: 'B' }]);
    await api('POST', `/api/goals/${partial.id}/tasks/${partial.tasks[0].id}/finish`);
    const complete = await create('Read a book', [{ title: 'Read' }]);
    await api('POST', `/api/goals/${complete.id}/tasks/${complete.tasks[0].id}/finish`);
    const empty = await create('Someday', []);

    clock = at('2026-11-01', '00:01');
    let res = await api('GET', '/api/goals');
    assert.equal(res.body.month, '2026-11');
    assert.deepEqual(res.body.goals.map((g) => [g.id, g.carriedFrom, g.progress]), [
      [partial.id, '2026-10', 50],
      [empty.id, '2026-10', 0],
    ]);
    assert.equal((await api('GET', `/api/goals/${complete.id}`)).status, 404);
    assert.deepEqual((await api('GET', '/api/goals?month=2026-10')).body.goals, []);

    clock = at('2026-12-01');
    res = await api('GET', '/api/goals');
    assert.equal(res.body.goals[0].carriedFrom, '2026-10', 'keeps the month it first came from');
  });

  test('the rollover runs once per day and catches up after downtime', async () => {
    await setup('2026-10-15');
    await addTask('2026-10-15', 'Thursday');
    await addTask('2026-10-16', 'Friday');

    clock = at('2026-10-20'); // server was "down" for days
    await today();
    await today();
    assert.deepEqual(titles((await today()).unfinished), ['Thursday', 'Friday']);
    const runs = t.db.prepare("SELECT run_key FROM job_runs WHERE name = 'rollover' ORDER BY run_key").all();
    assert.deepEqual(runs.map((r) => r.run_key), ['2026-10-15', '2026-10-20']);
  });

  test('/today also has the goal and project cards', async () => {
    await setup('2026-10-15');
    await api('POST', '/api/goals', { title: 'Goal', tasks: [{ title: 'T1' }] });
    await api('POST', '/api/projects', { title: 'Project', steps: [{ title: 'Design' }] });
    const view = await today();
    assert.equal(view.month, '2026-10');
    assert.deepEqual(view.goals.map((g) => [g.title, g.currentTask.title]), [['Goal', 'T1']]);
    assert.deepEqual(view.projects.map((p) => [p.title, p.currentStep.title]), [['Project', 'Design']]);
  });

  test('a day can be reordered', async () => {
    await setup('2026-10-15');
    const a = await addTask('2026-10-15', 'A');
    const b = await addTask('2026-10-15', 'B');
    let res = await api('PUT', '/api/days/2026-10-15/order', { taskIds: [b.id, a.id] });
    assert.deepEqual(titles(res.body.tasks), ['B', 'A']);
    res = await api('PUT', '/api/days/2026-10-15/order', { taskIds: [b.id] });
    assert.equal(res.status, 400);
  });

  test("another user can't see or change your tasks and repeating tasks", async () => {
    await setup('2026-10-15');
    const task = await addTask('2026-10-15', 'Private');
    const rule = (await api('POST', '/api/repeating', { title: 'Mine', weekdays: ['thu'] })).body;
    assert.deepEqual((await other('GET', '/api/today')).body.tasks, []);
    assert.equal((await other('PATCH', `/api/tasks/${task.id}`, { done: true })).status, 404);
    assert.equal((await other('DELETE', `/api/tasks/${task.id}`)).status, 404);
    assert.equal((await other('PATCH', `/api/repeating/${rule.id}`, { active: false })).status, 404);
    assert.equal((await other('DELETE', `/api/repeating/${rule.id}`)).status, 404);
  });

  test('bad input is rejected', async () => {
    await setup('2026-10-15');
    const task = await addTask('2026-10-15', 'X');
    assert.equal((await api('GET', '/api/days/2026-02-30')).status, 400);
    assert.equal((await api('POST', '/api/days/2026-10-15/tasks', { title: '' })).status, 400);
    assert.equal((await api('PATCH', `/api/tasks/${task.id}`, {})).status, 400);
    assert.equal((await api('PATCH', `/api/tasks/${task.id}`, { done: true, day: '2026-10-16' })).status, 400);
    assert.equal((await api('PATCH', `/api/tasks/${task.id}`, { done: 'yes' })).status, 400);
    assert.equal((await api('POST', '/api/repeating', { title: 'Gym', weekdays: [] })).status, 400);
    assert.equal((await api('POST', '/api/repeating', { title: 'Gym', weekdays: ['monday'] })).status, 400);
    assert.equal((await api('POST', '/api/repeating', { title: 'Gym' })).status, 400);
    assert.equal((await t.request('/api/today')).status, 401);
  });
});
