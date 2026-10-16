import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { monthOf } from '../src/time.js';
import { loggedIn, startTestServer } from './helpers.js';

const states = (goal) => goal.tasks.map((t) => t.state);

describe('monthly goals API', () => {
  let t, api, other;

  before(async () => {
    t = await startTestServer();
    api = await loggedIn(t, 'peter@example.test');
    other = await loggedIn(t, 'miles@example.test');
  });
  after(() => t.close());

  let goal;
  beforeEach(async () => {
    const res = await api('POST', '/api/goals', {
      title: 'Learn Spring',
      month: '2026-10',
      tasks: [{ title: 'Read docs' }, { title: 'Build API', dueDay: '2026-10-20' }, { title: 'Deploy' }],
    });
    assert.equal(res.status, 201);
    goal = res.body;
  });

  const path = (suffix = '') => `/api/goals/${goal.id}${suffix}`;
  const task = (i) => goal.tasks[i];

  test('a new goal opens only its first task', () => {
    assert.equal(goal.month, '2026-10');
    assert.equal(goal.carriedFrom, null);
    assert.deepEqual(states(goal), ['current', 'locked', 'locked']);
    assert.equal(task(1).dueDay, '2026-10-20');
    assert.equal(task(0).dueDay, null);
    assert.equal(goal.progress, 0);
  });

  test('tasks are finished in order and progress is finished / total', async () => {
    assert.equal((await api('POST', path(`/tasks/${task(1).id}/finish`))).status, 409);

    let res = await api('POST', path(`/tasks/${task(0).id}/finish`));
    assert.deepEqual(states(res.body), ['done', 'current', 'locked']);
    assert.equal(res.body.progress, 33);

    await api('POST', path(`/tasks/${task(1).id}/finish`));
    res = await api('POST', path(`/tasks/${task(2).id}/finish`));
    assert.equal(res.body.progress, 100);
    assert.equal(res.body.done, true);
  });

  test('only the last finished task can be reopened', async () => {
    await api('POST', path(`/tasks/${task(0).id}/finish`));
    await api('POST', path(`/tasks/${task(1).id}/finish`));
    assert.equal((await api('POST', path(`/tasks/${task(0).id}/reopen`))).status, 409);
    const res = await api('POST', path(`/tasks/${task(1).id}/reopen`));
    assert.deepEqual(states(res.body), ['done', 'current', 'locked']);
  });

  test('the list is per month and shows the current task', async () => {
    await api('POST', path(`/tasks/${task(0).id}/finish`));
    let res = await api('GET', '/api/goals?month=2026-10');
    assert.equal(res.body.month, '2026-10');
    const summary = res.body.goals.find((g) => g.id === goal.id);
    assert.deepEqual(summary.currentTask, { id: task(1).id, title: 'Build API', dueDay: '2026-10-20' });
    assert.equal(summary.tasksDone, 1);

    res = await api('GET', '/api/goals?month=2026-11');
    assert.deepEqual(res.body.goals, []);
  });

  test('without a month, goals are created in and listed for this month (IST)', async () => {
    const created = (await api('POST', '/api/goals', { title: 'This month' })).body;
    assert.equal(created.month, monthOf());
    const res = await api('GET', '/api/goals');
    assert.equal(res.body.month, monthOf());
    assert.ok(res.body.goals.some((g) => g.id === created.id));
  });

  test('task dates can be set and cleared, but not on finished tasks', async () => {
    let res = await api('PATCH', path(`/tasks/${task(1).id}`), { dueDay: null });
    assert.equal(res.body.tasks[1].dueDay, null);
    res = await api('PATCH', path(`/tasks/${task(2).id}`), { dueDay: '2026-11-02', title: 'Ship it' });
    assert.equal(res.body.tasks[2].dueDay, '2026-11-02');
    assert.equal(res.body.tasks[2].title, 'Ship it');

    await api('POST', path(`/tasks/${task(0).id}/finish`));
    res = await api('PATCH', path(`/tasks/${task(0).id}`), { dueDay: '2026-10-01' });
    assert.equal(res.status, 409);
    res = await api('PATCH', path(`/tasks/${task(0).id}`), { title: 'Read the docs' });
    assert.equal(res.status, 200);
  });

  test('tasks can be inserted, reordered and deleted while unfinished', async () => {
    await api('POST', path(`/tasks/${task(0).id}/finish`));

    let res = await api('POST', path('/tasks'), { title: 'Write tests', beforeTaskId: task(2).id });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.tasks.map((x) => x.title), ['Read docs', 'Build API', 'Write tests', 'Deploy']);
    assert.equal((await api('POST', path('/tasks'), { title: 'No', beforeTaskId: task(0).id })).status, 409);

    const tests = res.body.tasks[2];
    res = await api('PUT', path('/tasks/order'), { taskIds: [task(2).id, tests.id, task(1).id] });
    assert.deepEqual(res.body.tasks.map((x) => x.title), ['Read docs', 'Deploy', 'Write tests', 'Build API']);
    assert.equal(res.body.tasks[1].state, 'current');

    assert.equal((await api('DELETE', path(`/tasks/${task(0).id}`))).status, 409);
    res = await api('DELETE', path(`/tasks/${tests.id}`));
    assert.deepEqual(res.body.tasks.map((x) => x.title), ['Read docs', 'Deploy', 'Build API']);
  });

  test('rename and delete a goal', async () => {
    assert.equal((await api('PATCH', path(), { title: 'Learn Spring Boot' })).body.title, 'Learn Spring Boot');
    assert.equal((await api('DELETE', path())).status, 204);
    assert.equal((await api('GET', path())).status, 404);
  });

  test("another user can't see or change the goal", async () => {
    assert.equal((await other('GET', path())).status, 404);
    assert.equal((await other('POST', path(`/tasks/${task(0).id}/finish`))).status, 404);
    assert.equal((await other('DELETE', path())).status, 404);
    assert.deepEqual((await other('GET', '/api/goals?month=2026-10')).body.goals, []);
  });

  test('bad input is rejected', async () => {
    assert.equal((await api('GET', '/api/goals?month=2026-13')).status, 400);
    assert.equal((await api('POST', '/api/goals', { title: 'X', month: '10-2026' })).status, 400);
    assert.equal((await api('POST', '/api/goals', { title: 'X', tasks: [{ title: 'A', dueDay: '2026-02-30' }] })).status, 400);
    assert.equal((await api('POST', path('/tasks'), { title: 'A', dueDay: 'tomorrow' })).status, 400);
    assert.equal((await api('PATCH', path(`/tasks/${task(0).id}`), {})).status, 400);
    assert.equal((await api('PUT', path('/tasks/order'), { taskIds: [task(0).id, task(0).id] })).status, 400);
  });
});
