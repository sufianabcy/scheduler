import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { maskOf } from '../src/daily.js';
import { createNotifier } from '../src/notifications.js';
import { createPush, loadVapidKeys } from '../src/push.js';
import { nextOccurrence, occursOn } from '../src/recurrence.js';
import { loggedIn, startTestServer } from './helpers.js';

// Calendar: 2026-10-12 is a Monday, 2026-10-15 a Thursday.
const at = (day, time = '12:00') => new Date(`${day}T${time}:00+05:30`);
const rule = (fields) => ({ every: 1, weekdays: 127, end_day: null, ...fields });

describe('when a repeat happens', () => {
  test('every 2 days', () => {
    const r = rule({ freq: 'daily', every: 2, start_day: '2026-10-15' });
    assert.deepEqual(['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17'].map((d) => occursOn(r, d)), [false, true, false, true]);
  });

  test('every 2 weeks on Mon and Thu', () => {
    const r = rule({ freq: 'weekly', every: 2, weekdays: maskOf(['mon', 'thu']), start_day: '2026-10-15' });
    assert.equal(occursOn(r, '2026-10-12'), false, 'before the start');
    assert.equal(occursOn(r, '2026-10-15'), true);
    assert.equal(occursOn(r, '2026-10-19'), false, 'the next week is skipped');
    assert.equal(occursOn(r, '2026-10-26'), true);
    assert.equal(occursOn(r, '2026-10-29'), true);
    assert.equal(occursOn(r, '2026-10-27'), false, 'not a chosen weekday');
  });

  test('monthly on the 31st falls on the last day of shorter months', () => {
    const r = rule({ freq: 'monthly', start_day: '2026-10-31' });
    assert.equal(occursOn(r, '2026-11-30'), true);
    assert.equal(occursOn(r, '2027-02-28'), true);
    assert.equal(occursOn(r, '2026-12-31'), true);
    assert.equal(occursOn(r, '2026-12-30'), false);
  });

  test('every 3 months, until an end day', () => {
    const r = rule({ freq: 'monthly', every: 3, start_day: '2026-01-15', end_day: '2026-10-15' });
    assert.deepEqual(['2026-04-15', '2026-05-15', '2026-10-15', '2027-01-15'].map((d) => occursOn(r, d)), [true, false, true, false]);
    assert.equal(nextOccurrence(r, '2026-10-16'), null);
  });

  test('next occurrence', () => {
    const r = rule({ freq: 'weekly', weekdays: maskOf(['mon']), start_day: '2026-10-15' });
    assert.equal(nextOccurrence(r, '2026-10-15'), '2026-10-19');
  });
});

describe('repeat and reminders on daily tasks', () => {
  let t, api, clock;
  const setup = async (day = '2026-10-15', time = '12:00') => {
    clock = at(day, time);
    t = await startTestServer({ now: () => clock });
    api = await loggedIn(t, 'peter@example.test');
  };
  afterEach(() => t.close());
  const titles = async (day) => (await api('GET', `/api/days/${day}`)).body.tasks.map((x) => x.title);

  test('adding a task that repeats daily, with a reminder', async () => {
    await setup();
    const res = await api('POST', '/api/days/2026-10-15/tasks', {
      title: 'Meditate',
      repeat: { freq: 'daily' },
      remindAt: '07:00',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.firstDay, '2026-10-15');
    const task = res.body.tasks[0];
    assert.equal(task.remindAt, '07:00');
    assert.deepEqual(task.repeat, { ruleId: task.repeat.ruleId, freq: 'daily', every: 1, weekdays: [], startDay: '2026-10-15', until: null });
    assert.deepEqual(await titles('2026-10-16'), ['Meditate']);
    assert.equal((await api('GET', '/api/days/2026-10-16')).body.tasks[0].remindAt, '07:00');
  });

  test('a weekly repeat whose days skip the chosen day starts on the next one', async () => {
    await setup();
    const res = await api('POST', '/api/days/2026-10-15/tasks', { title: 'Team call', repeat: { freq: 'weekly', weekdays: ['mon'] } });
    assert.equal(res.body.firstDay, '2026-10-19');
    assert.deepEqual(res.body.tasks, []);
    assert.deepEqual(await titles('2026-10-19'), ['Team call']);
  });

  test('a weekly repeat with no weekdays uses the day it starts on', async () => {
    await setup();
    const res = await api('POST', '/api/days/2026-10-15/tasks', { title: 'Swim', repeat: { freq: 'weekly' } });
    assert.deepEqual(res.body.tasks[0].repeat.weekdays, ['thu']);
  });

  test('a one-off task can be made to repeat, changed, and stopped', async () => {
    await setup();
    const one = (await api('POST', '/api/days/2026-10-15/tasks', { title: 'Read' })).body.tasks[0];
    assert.equal(one.repeat, null);

    let res = await api('PATCH', `/api/tasks/${one.id}`, { repeat: { freq: 'weekly', weekdays: ['thu'] } });
    assert.equal(res.body.repeating, true);
    assert.deepEqual(res.body.repeat.weekdays, ['thu']);
    assert.deepEqual(await titles('2026-10-22'), ['Read']);

    res = await api('PATCH', `/api/tasks/${one.id}`, { repeat: { freq: 'weekly', weekdays: ['thu', 'sat'] } });
    assert.deepEqual(res.body.repeat.weekdays, ['thu', 'sat']);
    assert.equal(res.body.id, one.id, 'the task being edited stays');
    assert.deepEqual(await titles('2026-10-17'), ['Read']);

    res = await api('PATCH', `/api/tasks/${one.id}`, { repeat: null });
    assert.equal(res.body.repeating, false);
    assert.equal(res.body.repeat, null);
    assert.deepEqual(await titles('2026-10-15'), ['Read'], 'this one stays as a one-off');
    assert.deepEqual(await titles('2026-10-17'), []);
    assert.deepEqual((await api('GET', '/api/repeating')).body.rules, []);
  });

  test('renaming or changing the reminder of a repeating task changes its upcoming copies', async () => {
    await setup();
    const task = (await api('POST', '/api/days/2026-10-15/tasks', { title: 'Gym', repeat: { freq: 'daily' } })).body.tasks[0];
    await titles('2026-10-16');
    await api('PATCH', `/api/tasks/${task.id}`, { title: 'Gym (legs)', remindAt: '18:30' });
    const tomorrow = (await api('GET', '/api/days/2026-10-16')).body.tasks[0];
    assert.equal(tomorrow.title, 'Gym (legs)');
    assert.equal(tomorrow.remindAt, '18:30');
    const rules = (await api('GET', '/api/repeating')).body.rules;
    assert.equal(rules[0].title, 'Gym (legs)');
    assert.equal(rules[0].remindAt, '18:30');
  });

  test('a reminder can be set and cleared on a one-off task', async () => {
    await setup();
    const task = (await api('POST', '/api/days/2026-10-15/tasks', { title: 'Call', remindAt: '15:00' })).body.tasks[0];
    assert.equal(task.remindAt, '15:00');
    const res = await api('PATCH', `/api/tasks/${task.id}`, { remindAt: null });
    assert.equal(res.body.remindAt, null);
  });

  test('repeating tasks from More use the full repeat too', async () => {
    await setup();
    const res = await api('POST', '/api/repeating', {
      title: 'Pay rent',
      repeat: { freq: 'monthly', until: '2027-03-01' },
      startDay: '2026-11-01',
      remindAt: '09:00',
    });
    assert.equal(res.status, 201);
    assert.deepEqual(
      { freq: res.body.freq, startDay: res.body.startDay, until: res.body.until, remindAt: res.body.remindAt },
      { freq: 'monthly', startDay: '2026-11-01', until: '2027-03-01', remindAt: '09:00' },
    );
    assert.deepEqual(await titles('2026-12-01'), ['Pay rent']);
  });

  test('bad repeat and reminder input is rejected', async () => {
    await setup();
    const add = (body) => api('POST', '/api/days/2026-10-15/tasks', { title: 'X', ...body });
    assert.equal((await add({ repeat: { freq: 'yearly' } })).status, 400);
    assert.equal((await add({ repeat: { freq: 'daily', every: 0 } })).status, 400);
    assert.equal((await add({ repeat: { freq: 'daily', every: 1.5 } })).status, 400);
    assert.equal((await add({ repeat: { freq: 'weekly', weekdays: ['funday'] } })).status, 400);
    assert.equal((await add({ repeat: { freq: 'daily', until: '2026-10-01' } })).status, 400);
    assert.equal((await add({ remindAt: '7:00' })).status, 400);
    assert.equal((await add({ remindAt: '24:00' })).status, 400);
  });
});

describe('notification times and task reminders', () => {
  let t, api, clock, calls, notifier;
  async function setup(day = '2026-10-15', time = '05:00') {
    clock = at(day, time);
    t = await startTestServer({ now: () => clock });
    api = await loggedIn(t, 'peter@example.test');
    calls = [];
    const send = async (sub, payload) => {
      calls.push(JSON.parse(payload));
    };
    const push = createPush(t.db, { vapid: loadVapidKeys(t.db, {}), subject: 'mailto:x@example.test', send });
    push.subscribe(1, { endpoint: 'https://push.example.test/1', p256dh: 'a', auth: 'b' });
    notifier = createNotifier(t.db, { push, now: () => clock });
  }
  afterEach(() => t.close());
  const runAt = (day, time) => {
    clock = at(day, time);
    return notifier.runDue();
  };

  test('settings start at 23:00 and 06:00, and can be changed', async () => {
    await setup();
    let res = await api('GET', '/api/settings/notifications');
    assert.deepEqual(res.body, { eveningReminder: { on: true, time: '23:00' }, morningSummary: { on: true, time: '06:00' } });
    res = await api('PATCH', '/api/settings/notifications', { eveningReminder: { time: '21:30' }, morningSummary: { on: false } });
    assert.deepEqual(res.body, { eveningReminder: { on: true, time: '21:30' }, morningSummary: { on: false, time: '06:00' } });

    assert.equal((await api('PATCH', '/api/settings/notifications', { eveningReminder: { time: '09:00' } })).status, 400);
    assert.equal((await api('PATCH', '/api/settings/notifications', { morningSummary: { time: '13:00' } })).status, 400);
    assert.equal((await api('PATCH', '/api/settings/notifications', { morningSummary: { on: 'yes' } })).status, 400);
  });

  test('the morning summary goes at the chosen time, and not at all when turned off', async () => {
    await setup();
    await api('PATCH', '/api/settings/notifications', { morningSummary: { time: '07:30' }, eveningReminder: { on: false } });
    await runAt('2026-10-15', '06:00');
    assert.equal(calls.length, 0);
    await runAt('2026-10-15', '07:30');
    assert.deepEqual(calls.map((c) => c.tag), ['morning']);
    await runAt('2026-10-15', '23:00');
    assert.equal(calls.length, 1, 'evening reminder is off');

    await api('PATCH', '/api/settings/notifications', { eveningReminder: { on: true, time: '21:00' } });
    await runAt('2026-10-16', '21:00');
    assert.deepEqual(calls.map((c) => c.tag), ['morning', 'evening']);
  });

  test('a task reminder goes once, at its time, only while the task is open', async () => {
    await setup('2026-10-15', '08:00');
    const add = async (title, remindAt) =>
      (await api('POST', '/api/days/2026-10-15/tasks', { title, remindAt })).body.tasks.find((x) => x.title === title);
    await api('PATCH', '/api/settings/notifications', { morningSummary: { on: false }, eveningReminder: { on: false } });
    await add('Call bank', '10:00');
    const done = await add('Already done', '10:00');
    await api('PATCH', `/api/tasks/${done.id}`, { done: true });

    await runAt('2026-10-15', '09:59');
    assert.equal(calls.length, 0);
    await runAt('2026-10-15', '10:00');
    assert.deepEqual(calls, [{ title: 'Call bank', body: 'Reminder · 10:00 AM', url: '/#/', tag: calls[0].tag }]);
    await runAt('2026-10-15', '10:01');
    assert.equal(calls.length, 1, 'only once');
  });

  test('changing the reminder time sends it again at the new time', async () => {
    await setup('2026-10-15', '08:00');
    await api('PATCH', '/api/settings/notifications', { morningSummary: { on: false } });
    const task = (await api('POST', '/api/days/2026-10-15/tasks', { title: 'Stretch', remindAt: '09:00' })).body.tasks[0];
    await runAt('2026-10-15', '09:00');
    await api('PATCH', `/api/tasks/${task.id}`, { remindAt: '11:00' });
    await runAt('2026-10-15', '11:00');
    assert.equal(calls.length, 2);
  });

  test("a repeating task's reminder fires even if the app wasn't opened that day", async () => {
    await setup('2026-10-15', '08:00');
    await api('PATCH', '/api/settings/notifications', { morningSummary: { on: false } });
    await api('POST', '/api/days/2026-10-15/tasks', { title: 'Water plants', repeat: { freq: 'daily' }, remindAt: '08:30' });
    await runAt('2026-10-16', '08:30');
    assert.deepEqual(calls.map((c) => c.title), ['Water plants']);
  });

  test('a reminder missed by more than 15 minutes (server down) is skipped', async () => {
    await setup('2026-10-15', '08:00');
    await api('PATCH', '/api/settings/notifications', { morningSummary: { on: false } });
    await api('POST', '/api/days/2026-10-15/tasks', { title: 'Late', remindAt: '09:00' });
    await runAt('2026-10-15', '09:16');
    assert.equal(calls.length, 0);
  });
});
