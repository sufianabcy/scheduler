import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { loggedIn, startTestServer } from './helpers.js';

const at = (day, time = '12:00') => new Date(`${day}T${time}:00+05:30`);

describe('task priority', () => {
  let t, api;
  const setup = async () => {
    const clock = at('2026-10-15');
    t = await startTestServer({ now: () => clock });
    api = await loggedIn(t, 'peter@example.test');
  };
  afterEach(() => t.close());
  const add = async (title, extra = {}, day = '2026-10-15') =>
    (await api('POST', `/api/days/${day}/tasks`, { title, ...extra })).body.tasks.find((x) => x.title === title);
  const list = async (day = '2026-10-15') => (await api('GET', `/api/days/${day}`)).body.tasks.map((x) => [x.title, x.priority]);

  test('P1 tasks are listed first, then P2, P3, then tasks without a priority', async () => {
    await setup();
    await add('None');
    await add('Low', { priority: 3 });
    await add('Urgent', { priority: 1 });
    await add('Medium', { priority: 2 });
    await add('Also urgent', { priority: 1 });
    assert.deepEqual(await list(), [
      ['Urgent', 1],
      ['Also urgent', 1],
      ['Medium', 2],
      ['Low', 3],
      ['None', null],
    ]);
  });

  test('priority can be changed and cleared', async () => {
    await setup();
    const task = await add('Call bank');
    let res = await api('PATCH', `/api/tasks/${task.id}`, { priority: 2 });
    assert.equal(res.body.priority, 2);
    res = await api('PATCH', `/api/tasks/${task.id}`, { priority: null });
    assert.equal(res.body.priority, null);
  });

  test('a repeating task passes its priority to every copy, and a change applies to upcoming ones', async () => {
    await setup();
    const task = await add('Gym', { priority: 2, repeat: { freq: 'daily' } });
    assert.equal(task.priority, 2);
    assert.deepEqual(await list('2026-10-16'), [['Gym', 2]]);

    await api('PATCH', `/api/tasks/${task.id}`, { priority: 1 });
    assert.deepEqual(await list('2026-10-16'), [['Gym', 1]]);
    assert.deepEqual(await list('2026-10-17'), [['Gym', 1]]);
    assert.equal((await api('GET', '/api/repeating')).body.rules[0].priority, 1);
  });

  test('making a task repeat keeps its priority', async () => {
    await setup();
    const task = await add('Read', { priority: 3 });
    await api('PATCH', `/api/tasks/${task.id}`, { repeat: { freq: 'daily' } });
    assert.deepEqual(await list('2026-10-16'), [['Read', 3]]);
  });

  test('the morning summary lists P1 first', async () => {
    await setup();
    await add('Later');
    await add('First', { priority: 1 });
    const today = (await api('GET', '/api/today')).body.tasks.map((x) => x.title);
    assert.deepEqual(today, ['First', 'Later']);
  });

  test('only 1, 2, 3 or null', async () => {
    await setup();
    for (const priority of [0, 4, '1', 1.5]) {
      assert.equal((await api('POST', '/api/days/2026-10-15/tasks', { title: 'X', priority })).status, 400, String(priority));
    }
  });
});
