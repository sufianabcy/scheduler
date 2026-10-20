import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, test } from 'node:test';
import { flatten } from '../src/lms/client.js';
import { createLms, statusAt } from '../src/lms/index.js';
import { createNotifier } from '../src/notifications.js';
import { startFakeLms } from './fake-lms.js';
import { cookieFrom, randomPassword, startTestServer } from './helpers.js';

const at = (iso) => new Date(iso);
// The fixtures are built around this moment: Tuesday 20 October 2026, 10:00 IST.
const START = '2026-10-20T10:00:00+05:30';

describe('helpers', () => {
  test("Moodle's nested parameters", () => {
    assert.deepEqual(flatten({ courseids: [3, 5], options: { ids: [1] }, on: true, skip: null }), {
      'courseids[0]': '3',
      'courseids[1]': '5',
      'options[ids][0]': '1',
      on: '1',
    });
  });

  test('status from the dates', () => {
    const now = '2026-10-20T04:30:00.000Z';
    assert.equal(statusAt({ dueAt: '2026-10-21T00:00:00.000Z', cutoffAt: null }, now), 'upcoming');
    assert.equal(statusAt({ dueAt: '2026-10-19T00:00:00.000Z', cutoffAt: null }, now), 'overdue');
    assert.equal(statusAt({ dueAt: '2026-10-19T00:00:00.000Z', cutoffAt: '2026-10-25T00:00:00.000Z' }, now), 'overdue');
    assert.equal(statusAt({ dueAt: '2026-10-19T00:00:00.000Z', cutoffAt: '2026-10-20T00:00:00.000Z' }, now), 'missed');
    assert.equal(statusAt({ dueAt: null, cutoffAt: null }, now), 'upcoming');
  });
});

/** A test app with the LMS pointed at the fake Moodle, a clock we can move, recorded pushes and logs. */
async function setup({ tokenKey = randomBytes(32).toString('base64') } = {}) {
  const fake = await startFakeLms();
  const clock = { now: at(START) };
  const pushes = [];
  const push = { sendTo: async (userId, message) => (pushes.push({ userId, ...message }), { sent: 1, failed: 0, errors: [] }) };
  // Everything the server logs, to check that no secret ends up there.
  const logs = [];
  const original = { error: console.error, log: console.log };
  console.error = (...args) => logs.push(args.map(String).join(' '));
  console.log = (...args) => logs.push(args.map(String).join(' '));

  const t = await startTestServer({
    now: () => clock.now,
    lms: (db) => createLms(db, { config: { lms: { tokenKey, url: fake.url } }, now: () => clock.now, push }),
  });
  const password = randomPassword();
  await t.addUser('peter@example.test', password);
  const login = await t.request('/api/auth/login', { method: 'POST', body: { email: 'peter@example.test', password } });
  const cookie = cookieFrom(login);
  const api = async (method, path, body) => {
    const r = await t.request(path, { method, cookie, body: method === 'GET' ? undefined : (body ?? {}) });
    return { status: r.status, body: r.status === 204 ? null : await r.json() };
  };
  const connect = async () => {
    const res = await api('POST', '/api/lms/connect', { username: fake.state.username, password: fake.state.password });
    await t.lms.settled();
    return res;
  };
  const items = async (status = 'all') => (await api('GET', `/api/lms/items?status=${status}`)).body.items;
  const byId = async () => Object.fromEntries((await items()).map((i) => [i.id, i]));
  const lmsTasks = (rows) => rows.filter((task) => task.lms);
  return {
    fake,
    t,
    clock,
    pushes,
    logs,
    api,
    connect,
    items,
    byId,
    lmsTasks,
    async close() {
      console.error = original.error;
      console.log = original.log;
      await t.close();
      await fake.close();
    },
  };
}

let env;
afterEach(async () => {
  await env?.close();
  env = null;
});

describe('connecting', () => {
  test('switched off without LMS_TOKEN_KEY', async () => {
    env = await setup({ tokenKey: '' });
    const status = await env.api('GET', '/api/lms/status');
    assert.equal(status.body.enabled, false);
    const res = await env.api('POST', '/api/lms/connect', { username: 'student', password: 'x' });
    assert.equal(res.status, 503);
  });

  test('a wrong password is refused, and stops after 5 tries', async () => {
    env = await setup();
    for (let i = 0; i < 5; i++) {
      const res = await env.api('POST', '/api/lms/connect', { username: 'student', password: `wrong-${i}` });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /Wrong LMS username or password/);
    }
    const blocked = await env.api('POST', '/api/lms/connect', { username: 'student', password: env.fake.state.password });
    assert.equal(blocked.status, 429);
    assert.equal(env.fake.state.calls.filter((c) => c.path === '/login/token.php').length, 5);
  });

  test('only the token is kept, encrypted; the password and token never reach the database or the logs', async () => {
    env = await setup();
    const res = await env.connect();
    assert.equal(res.status, 200);
    assert.equal(res.body.connected, true);
    assert.equal(res.body.status, 'ok');

    const { password, token } = env.fake.state;
    const dump = JSON.stringify(
      env.t.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().flatMap(({ name }) => env.t.db.prepare(`SELECT * FROM "${name}"`).all()),
    );
    assert.ok(!dump.includes(password), 'password stored');
    assert.ok(!dump.includes(token), 'token stored in plain text');
    assert.ok(!dump.includes('private-should-be-ignored'));
    assert.match(env.t.db.prepare('SELECT token FROM lms_accounts').get().token, /^v1\./);
    assert.ok(!env.logs.join('\n').includes(password));
    assert.ok(!env.logs.join('\n').includes(token));

    // The password only went to token.php, and the token only in request bodies, never in a URL.
    const withPassword = env.fake.state.bodies.filter((b) => b.includes(encodeURIComponent(password).replace(/%20/g, '+')));
    assert.equal(withPassword.length, 1);
    assert.ok(env.fake.state.calls.every((c) => !JSON.stringify(c).includes(token)));

    const status = await env.api('GET', '/api/lms/status');
    assert.ok(!JSON.stringify(status.body).includes(token));
  });
});

describe('sync', () => {
  test('the first sync sorts work into upcoming, overdue, missed and done', async () => {
    env = await setup();
    await env.connect();
    const items = await env.byId();

    assert.deepEqual(
      Object.fromEntries(Object.entries(items).map(([id, i]) => [id, i.status])),
      {
        'assign:501': 'done',
        'assign:502': 'missed',
        'assign:503': 'overdue',
        'assign:601': 'upcoming',
        'assign:604': 'upcoming',
        'quiz:701': 'done',
        'quiz:702': 'upcoming',
        'forum:801': 'upcoming',
      },
    );
    // Too old, nothing to hand in, or no deadline: left out.
    assert.equal(items['assign:602'], undefined);
    assert.equal(items['assign:603'], undefined);
    assert.equal(items['quiz:703'], undefined);

    const lab = items['assign:503'];
    assert.equal(lab.course, 'Probability & Statistics');
    assert.equal(lab.courseShort, 'MT-101');
    assert.equal(lab.dueAt, '2026-10-18T04:30:00.000Z');
    assert.equal(lab.cutoffAt, '2026-10-23T04:30:00.000Z');
    assert.match(lab.url, /\/mod\/assign\/view\.php\?id=503$/);
    assert.equal(items['assign:501'].grade, '9.00 / 10.00');
    assert.equal(items['assign:501'].submittedAt, new Date(1790656200 * 1000).toISOString());

    // Overdue first, then upcoming by due date.
    assert.deepEqual((await env.items('open')).map((i) => i.id), ['assign:503', 'assign:604', 'assign:601', 'quiz:702', 'forum:801']);
    assert.deepEqual((await env.items('missed')).map((i) => i.id), ['assign:502']);

    // Already missed when first seen: no "missed" notification for old work.
    assert.equal(env.pushes.length, 0);

    const status = (await env.api('GET', '/api/lms/status')).body;
    assert.deepEqual(status.counts, { upcoming: 4, overdue: 1, missed: 1, done: 2 });
    assert.deepEqual(status.missingFunctions, []);
    assert.ok(status.lastSyncedAt);
  });

  test('upcoming and overdue work becomes planner tasks on its due day; overdue work on today', async () => {
    env = await setup();
    await env.connect();
    const today = (await env.api('GET', '/api/today')).body;
    const tasks = env.lmsTasks(today.tasks);
    assert.deepEqual(tasks.map((task) => [task.title, task.lms.status]).sort(), [['Lab report 3', 'overdue'], ['Tree traversal', 'upcoming']]);
    const lab = tasks.find((task) => task.title === 'Lab report 3');
    assert.equal(lab.lms.course, 'Probability & Statistics');
    assert.match(lab.lms.url, /\/mod\/assign\/view\.php\?id=503$/);
    assert.equal(today.lms.connected, true);
    assert.equal(today.lms.needsReconnect, false);

    const tomorrow = env.lmsTasks((await env.api('GET', '/api/days/2026-10-21')).body.tasks);
    assert.deepEqual(tomorrow.map((task) => task.title), ['Linked list exercise']);
    assert.deepEqual(env.lmsTasks((await env.api('GET', '/api/days/2026-10-22')).body.tasks).map((task) => task.title), ['Quiz 2']);
    assert.deepEqual(env.lmsTasks((await env.api('GET', '/api/days/2026-10-23')).body.tasks).map((task) => task.title), ['Week 9 discussion']);

    // Syncing again doesn't make the tasks twice.
    env.clock.now = at('2026-10-20T11:00:00+05:30');
    await env.api('POST', '/api/lms/sync');
    assert.equal(env.t.db.prepare('SELECT count(*) AS n FROM daily_tasks').get().n, 5);
  });

  test('a submission on the LMS ticks the task by itself', async () => {
    env = await setup();
    await env.connect();
    env.fake.state.submissions['13'] = { lastattempt: { submission: { status: 'submitted', timemodified: 1792473000 } }, warnings: [] };
    env.fake.state.events = env.fake.state.events.filter((e) => !e.url.endsWith('id=503'));
    env.clock.now = at('2026-10-20T11:00:00+05:30');
    const res = await env.api('POST', '/api/lms/sync');
    assert.equal(res.status, 200);
    assert.equal(res.body.counts.done, 3);

    const lab = env.lmsTasks((await env.api('GET', '/api/today')).body.tasks).find((task) => task.title === 'Lab report 3');
    assert.equal(lab.status, 'done');
    assert.equal(lab.lms.status, 'done');
  });

  test('the second sync on a day reuses the course lists and only checks work that is still open', async () => {
    env = await setup();
    await env.connect();
    const before = env.fake.state.calls.length;
    env.clock.now = at('2026-10-20T12:00:00+05:30');
    await env.api('POST', '/api/lms/sync');
    const calls = env.fake.state.calls.slice(before).map((c) => c.wsfunction);
    assert.ok(!calls.includes('mod_assign_get_assignments'));
    assert.ok(!calls.includes('mod_quiz_get_quizzes_by_courses'));
    // 503, 601 and 604 are open; 501 is done and 502 already missed.
    assert.deepEqual(
      env.fake.callsOf('mod_assign_get_submission_status').slice(-3).map((c) => c.params.assignid).sort(),
      ['13', '21', '24'],
    );
    assert.equal(calls.filter((c) => c === 'mod_assign_get_submission_status').length, 3);
    assert.equal(calls.filter((c) => c === 'mod_quiz_get_user_attempts').length, 1);

    // Next day: the lists are fetched again.
    env.clock.now = at('2026-10-21T08:00:00+05:30');
    await env.api('POST', '/api/lms/sync');
    assert.equal(env.fake.callsOf('mod_assign_get_assignments').length, 2);
  });

  test('"Sync now" twice within 20 seconds syncs once; opening the app syncs at most every 10 minutes', async () => {
    env = await setup();
    await env.connect();
    const syncs = () => env.fake.callsOf('core_webservice_get_site_info').length;
    const first = syncs();
    await env.api('POST', '/api/lms/sync');
    assert.equal(syncs(), first);
    env.clock.now = at('2026-10-20T10:05:00+05:30');
    await env.api('POST', '/api/lms/sync', { auto: true });
    await env.t.lms.settled();
    assert.equal(syncs(), first);
    await env.api('POST', '/api/lms/sync');
    assert.equal(syncs(), first + 1);
    env.clock.now = at('2026-10-20T10:20:00+05:30');
    const res = await env.api('POST', '/api/lms/sync', { auto: true });
    assert.equal(res.status, 200);
    await env.t.lms.settled();
    assert.equal(syncs(), first + 2);
  });

  test('every 2 hours from the job timer', async () => {
    env = await setup();
    await env.connect();
    const syncs = () => env.fake.callsOf('core_webservice_get_site_info').length;
    const first = syncs();
    env.clock.now = at('2026-10-20T11:30:00+05:30');
    await env.t.lms.runDue();
    assert.equal(syncs(), first);
    env.clock.now = at('2026-10-20T12:01:00+05:30');
    await env.t.lms.runDue();
    assert.equal(syncs(), first + 1);
  });

  test('overdue tasks move to today at midnight instead of going to Unfinished', async () => {
    env = await setup();
    await env.connect();
    // Tree traversal was due at 18:00 on the 20th; its cut-off is a week later.
    env.clock.now = at('2026-10-21T09:00:00+05:30');
    const today = (await env.api('GET', '/api/today')).body;
    assert.equal(today.day, '2026-10-21');
    const tree = env.lmsTasks(today.tasks).find((task) => task.title === 'Tree traversal');
    assert.equal(tree.day, '2026-10-21');
    assert.equal(tree.status, 'open');
    assert.equal(tree.lms.status, 'overdue');
    assert.ok(!today.unfinished.some((task) => task.lms));
  });

  test('work whose cut-off passes becomes missed: its task goes and one notification is sent', async () => {
    env = await setup();
    await env.connect();
    env.clock.now = at('2026-10-24T12:00:00+05:30');
    await env.api('POST', '/api/lms/sync');
    const items = await env.byId();
    // Lab report 3's cut-off was 23 Oct; Quiz 2 closed on 22 Oct.
    assert.equal(items['assign:503'].status, 'missed');
    assert.equal(items['quiz:702'].status, 'missed');
    assert.equal(env.pushes.length, 1);
    assert.equal(env.pushes[0].title, 'Missed on LMS: 2 items');
    assert.equal(env.pushes[0].url, '/#/lms/missed');
    const titles = env.t.db.prepare("SELECT title FROM daily_tasks WHERE status IN ('open', 'unfinished')").all().map((r) => r.title);
    assert.ok(!titles.includes('Lab report 3'));
    assert.ok(!titles.includes('Quiz 2'));

    // Not sent again on the next sync.
    env.clock.now = at('2026-10-24T15:00:00+05:30');
    await env.api('POST', '/api/lms/sync');
    assert.equal(env.pushes.length, 1);
  });

  test('a task you delete is not made again', async () => {
    env = await setup();
    await env.connect();
    const forum = env.lmsTasks((await env.api('GET', '/api/days/2026-10-23')).body.tasks)[0];
    assert.equal((await env.api('DELETE', `/api/tasks/${forum.id}`)).status, 204);
    env.clock.now = at('2026-10-20T11:00:00+05:30');
    await env.api('POST', '/api/lms/sync');
    assert.equal(env.lmsTasks((await env.api('GET', '/api/days/2026-10-23')).body.tasks).length, 0);
    assert.equal((await env.byId())['forum:801'].status, 'upcoming');
  });

  test('a calendar-only activity that drops off the timeline counts as done', async () => {
    env = await setup();
    await env.connect();
    env.fake.state.events = env.fake.state.events.filter((e) => e.modulename !== 'forum');
    env.clock.now = at('2026-10-20T11:00:00+05:30');
    await env.api('POST', '/api/lms/sync');
    assert.equal((await env.byId())['forum:801'].status, 'done');
  });

  test('calendar-only work with no cut-off that drops off after its due date counts as done, not overdue forever', async () => {
    env = await setup();
    await env.connect();
    env.fake.state.events = env.fake.state.events.filter((e) => e.modulename !== 'forum');
    env.clock.now = at('2026-10-25T10:00:00+05:30'); // past the forum's due date; it has no cut-off
    await env.api('POST', '/api/lms/sync');
    assert.equal((await env.byId())['forum:801'].status, 'done');
    // Still done after the statuses are worked out again (the bug: it flipped back to overdue here).
    assert.equal((await env.byId())['forum:801'].status, 'done');
    const today = (await env.api('GET', '/api/today')).body.tasks;
    assert.ok(!today.some((task) => task.lms?.itemId === 'forum:801' && task.lms.status === 'overdue'));
  });

  test('calendar-only work whose cut-off passed while off the timeline stays missed', async () => {
    env = await setup();
    // No quiz functions: the quiz is only known from the calendar, where its cut-off is its close time.
    env.fake.allowOnly(['core_enrol_get_users_courses', 'core_calendar_get_action_events_by_timesort', 'mod_assign_get_assignments', 'mod_assign_get_submission_status']);
    await env.connect();
    assert.equal((await env.byId())['quiz:702'].status, 'upcoming');
    env.fake.state.events = env.fake.state.events.filter((e) => e.id !== 9004);
    env.clock.now = at('2026-10-23T10:00:00+05:30'); // after the quiz closed
    await env.api('POST', '/api/lms/sync');
    assert.equal((await env.byId())['quiz:702'].status, 'missed');
    assert.equal((await env.byId())['quiz:702'].status, 'missed');
  });

  test('the Today page gets an LMS summary: counts, the next upcoming work, last sync', async () => {
    env = await setup();
    let lms = (await env.api('GET', '/api/today')).body.lms;
    assert.deepEqual(lms, { enabled: true, connected: false, needsReconnect: false });
    await env.connect();
    lms = (await env.api('GET', '/api/today')).body.lms;
    const counts = { upcoming: 0, overdue: 0, missed: 0, done: 0 };
    for (const i of await env.items()) counts[i.status] += 1;
    assert.deepEqual(lms.counts, counts);
    assert.equal(lms.connected, true);
    assert.ok(lms.lastSyncedAt);
    const upcoming = await env.items('upcoming');
    assert.deepEqual(lms.upcoming.map((i) => i.id), upcoming.slice(0, 5).map((i) => i.id));
    assert.ok(lms.upcoming.every((i, n) => n === 0 || lms.upcoming[n - 1].dueAt <= i.dueAt));
  });

  test('a task you move to another day stays there', async () => {
    env = await setup();
    await env.connect();
    const quiz = (await env.byId())['quiz:702'];
    const task = () => env.t.db.prepare('SELECT day FROM daily_tasks WHERE id = ?').get(quiz.taskId).day;
    assert.equal(task(), '2026-10-22'); // its due day
    await env.api('PATCH', `/api/tasks/${quiz.taskId}`, { day: '2026-10-21' }); // do it a day early
    env.clock.now = at('2026-10-20T11:00:00+05:30');
    await env.api('POST', '/api/lms/sync');
    assert.equal(task(), '2026-10-21');
    env.clock.now = at('2026-10-20T13:30:00+05:30');
    await env.t.lms.runDue();
    assert.equal(task(), '2026-10-21');
  });

  test('one activity the LMS refuses does not ask you to reconnect', async () => {
    env = await setup();
    await env.connect();
    // Assignment 13 (Probability & Statistics) is open, so every sync checks its submission.
    env.fake.state.submissions['13'] = { exception: 'webservice_access_exception', errorcode: 'accessexception', message: 'Access control exception' };
    env.clock.now = at('2026-10-20T11:00:00+05:30');
    const res = await env.api('POST', '/api/lms/sync');
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.lastError, null);
    assert.equal(env.pushes.filter((p) => p.tag === 'lms-reconnect').length, 0);
    assert.equal((await env.api('GET', '/api/today')).body.lms.needsReconnect, false);
  });

  test('the timeline is read page by page', async () => {
    env = await setup();
    const base = env.fake.state.events[4];
    for (let i = 0; i < 70; i++) {
      env.fake.state.events.push({ ...base, id: 10_000 + i, activityname: `Reading ${i}`, url: `${env.fake.url}/mod/forum/view.php?id=${2000 + i}`, timesort: base.timesort + i * 60 });
    }
    await env.connect();
    const pages = env.fake.callsOf('core_calendar_get_action_events_by_timesort');
    assert.equal(pages.length, 2);
    const fiftieth = [...env.fake.state.events].sort((a, b) => a.timesort - b.timesort || a.id - b.id)[49];
    assert.equal(pages[1].params.aftereventid, String(fiftieth.id));
    assert.equal((await env.items('open')).filter((i) => i.title.startsWith('Reading')).length, 70);
  });

  test('functions the token may not call are skipped; the calendar fills in', async () => {
    env = await setup();
    env.fake.allowOnly(['core_enrol_get_users_courses', 'core_calendar_get_action_events_by_timesort', 'mod_assign_get_assignments']);
    await env.connect();
    const status = (await env.api('GET', '/api/lms/status')).body;
    assert.equal(status.status, 'ok');
    assert.equal(status.lastError, null);
    assert.deepEqual(status.missingFunctions, [
      'core_course_get_enrolled_courses_by_timeline_classification',
      'mod_assign_get_submission_status',
      'mod_quiz_get_quizzes_by_courses',
      'mod_quiz_get_user_attempts',
    ]);
    for (const fn of status.missingFunctions) assert.equal(env.fake.callsOf(fn).length, 0, fn);
    const items = await env.byId();
    assert.equal(items['assign:503'].status, 'overdue');
    assert.equal(items['quiz:702'].status, 'upcoming');
    // Without submission status: past cut-off and gone from the timeline counts as missed.
    assert.equal(items['assign:502'].status, 'missed');

    // Submitted (so it drops off the timeline): done.
    env.fake.state.events = env.fake.state.events.filter((e) => !e.url.endsWith('id=503'));
    env.clock.now = at('2026-10-20T11:00:00+05:30');
    await env.api('POST', '/api/lms/sync');
    assert.equal((await env.byId())['assign:503'].status, 'done');
  });

  test('a dead token marks the LMS for reconnecting and notifies once', async () => {
    env = await setup();
    await env.connect();
    env.fake.state.tokenValid = false;
    env.clock.now = at('2026-10-20T11:00:00+05:30');
    const res = await env.api('POST', '/api/lms/sync');
    assert.equal(res.body.status, 'needs_reconnect');
    assert.equal(env.pushes.length, 1);
    assert.equal(env.pushes[0].title, 'Reconnect LMS');
    assert.equal((await env.api('GET', '/api/today')).body.lms.needsReconnect, true);

    // No more syncs or notifications until it's connected again.
    env.clock.now = at('2026-10-20T14:00:00+05:30');
    await env.t.lms.runDue();
    assert.equal(env.pushes.length, 1);

    // Connecting again keeps the synced work and tasks.
    const again = await env.connect();
    assert.equal(again.body.status, 'ok');
    assert.equal((await env.items()).length, 8);
    assert.equal(env.t.db.prepare('SELECT count(*) AS n FROM daily_tasks').get().n, 5);
  });

  test('an LMS that is down records the error and keeps what was synced', async () => {
    env = await setup();
    await env.connect();
    await env.fake.close();
    env.clock.now = at('2026-10-20T11:00:00+05:30');
    const res = await env.api('POST', '/api/lms/sync');
    assert.equal(res.body.status, 'ok');
    assert.match(res.body.lastError, /Can't reach the LMS/);
    assert.equal((await env.items()).length, 8);
    env.fake.close = async () => {};
  });
});

describe('courses', () => {
  test('hiding a course takes its open tasks off the plan; showing it brings them back', async () => {
    env = await setup();
    await env.connect();
    const courses = (await env.api('GET', '/api/lms/courses')).body.courses;
    assert.deepEqual(courses.map((c) => [c.id, c.name, c.open, c.missed]), [[102, 'Data Structures', 3, 0], [101, 'Probability & Statistics', 2, 1]]);

    const hidden = await env.api('PATCH', '/api/lms/courses/102', { hidden: true });
    assert.equal(hidden.body.hidden, true);
    assert.deepEqual(env.lmsTasks((await env.api('GET', '/api/today')).body.tasks).map((task) => task.title), ['Lab report 3']);
    assert.ok((await env.items()).every((i) => i.courseId !== 102));

    await env.api('PATCH', '/api/lms/courses/102', { hidden: false });
    assert.deepEqual(env.lmsTasks((await env.api('GET', '/api/today')).body.tasks).map((task) => task.title).sort(), ['Lab report 3', 'Tree traversal']);
  });

  test('a task you deleted stays deleted after hiding and showing its course', async () => {
    env = await setup();
    await env.connect();
    const todayLms = async () => env.lmsTasks((await env.api('GET', '/api/today')).body.tasks);
    const tree = (await todayLms()).find((task) => task.title === 'Tree traversal');
    await env.api('DELETE', `/api/tasks/${tree.id}`);
    await env.api('PATCH', '/api/lms/courses/102', { hidden: true });
    await env.api('PATCH', '/api/lms/courses/102', { hidden: false });
    assert.deepEqual((await todayLms()).map((task) => task.title), ['Lab report 3']);
    const items = await env.byId();
    assert.equal(items[tree.lms.itemId].taskId, null);
    // The course's other tasks, which hiding took off the plan, are back.
    assert.ok(items['quiz:702'].taskId);
  });

  test('a course can be linked to one of your projects', async () => {
    env = await setup();
    await env.connect();
    const project = (await env.api('POST', '/api/projects', { title: 'Stats' })).body;
    const res = await env.api('PATCH', '/api/lms/courses/101', { projectId: project.id });
    assert.equal(res.body.projectId, project.id);
    assert.equal((await env.byId())['assign:503'].projectId, project.id);
    assert.equal((await env.api('PATCH', '/api/lms/courses/101', { projectId: 99999 })).status, 404);
    assert.equal((await env.api('PATCH', '/api/lms/courses/101', { projectId: null })).body.projectId, null);
  });

  test('semester start limits how far back to look', async () => {
    env = await setup();
    await env.connect();
    const res = await env.api('PATCH', '/api/lms/settings', { semesterStart: '2026-09-01' });
    assert.equal(res.body.semesterStart, '2026-09-01');
    assert.equal((await env.api('PATCH', '/api/lms/settings', { semesterStart: '1 Sept' })).status, 400);
    env.clock.now = at('2026-10-20T11:00:00+05:30');
    await env.api('POST', '/api/lms/sync');
    const last = env.fake.callsOf('core_calendar_get_action_events_by_timesort').at(-1);
    assert.equal(last.params.timesortfrom, String(Date.parse('2026-09-01T00:00:00+05:30') / 1000));
    // A new start re-reads the course lists.
    assert.equal(env.fake.callsOf('mod_assign_get_assignments').length, 2);
  });

  test('disconnecting forgets the token and the synced work; tasks stay as plain tasks', async () => {
    env = await setup();
    await env.connect();
    assert.equal((await env.api('POST', '/api/lms/disconnect')).status, 204);
    assert.equal((await env.api('GET', '/api/lms/status')).body.connected, false);
    assert.equal(env.t.db.prepare('SELECT count(*) AS n FROM lms_items').get().n, 0);
    assert.equal(env.t.db.prepare('SELECT count(*) AS n FROM lms_accounts').get().n, 0);
    const today = (await env.api('GET', '/api/today')).body;
    assert.equal(today.tasks.length, 2);
    assert.ok(today.tasks.every((task) => task.lms === null));
  });
});

describe('notifications', () => {
  test('23:00 says what is due tomorrow and what is still overdue; 06:00 what is due today', async () => {
    env = await setup();
    await env.connect();
    const notifier = createNotifier(env.t.db, { push: { sendTo: async () => ({ sent: 1, failed: 0 }) }, lms: env.t.lms, now: () => env.clock.now });

    // No tasks of your own tomorrow: "Plan tomorrow" with the LMS lines. By 23:00, Tree traversal (due 18:00) is overdue too.
    env.clock.now = at('2026-10-20T23:00:00+05:30');
    const evening = notifier.preview('evening', 1, at('2026-10-20T23:00:00+05:30'));
    assert.equal(evening.title, 'Plan tomorrow');
    assert.match(evening.body, /Due tomorrow: Linked list exercise/);
    assert.match(evening.body, /Still overdue: 2 on the LMS/);

    // With your own task tomorrow, only the LMS part.
    await env.api('POST', '/api/days/2026-10-21/tasks', { title: 'Gym' });
    const planned = notifier.preview('evening', 1, at('2026-10-20T23:00:00+05:30'));
    assert.equal(planned.title, 'Due tomorrow: 1 on the LMS');

    env.clock.now = at('2026-10-22T06:00:00+05:30');
    const morning = notifier.preview('morning', 1, at('2026-10-22T06:00:00+05:30'));
    assert.match(morning.body, /Due today on the LMS: Quiz 2/);
  });
});
