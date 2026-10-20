import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { openDb } from '../src/db.js';
import { createUser, removeUser } from '../src/users.js';
import { randomPassword, startTestServer } from './helpers.js';

const serverDir = join(import.meta.dirname, '..');

describe('database', () => {
  test('migrations create every table and set the schema version', () => {
    const db = openDb(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name);
    for (const name of [
      'users', 'sessions', 'repeating_tasks', 'daily_tasks', 'monthly_goals', 'goal_tasks',
      'projects', 'project_steps', 'step_items', 'templates', 'template_steps', 'push_subscriptions', 'job_runs', 'repeat_skips', 'app_settings', 'notification_settings', 'mail_accounts', 'mail_messages', 'lms_accounts', 'lms_courses', 'lms_items',
    ]) {
      assert.ok(tables.includes(name), `missing table ${name}`);
    }
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 10);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    db.close();
  });

  test('opening an existing database again does not re-run migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'planner-'));
    try {
      const path = join(dir, 'data', 'planner.db');
      openDb(path).close();
      const db = openDb(path);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 10);
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('migration 9 takes the tasks made from LMS work off the plan, and only those', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'planner-'));
    try {
      const path = join(dir, 'planner.db');
      let db = openDb(path);
      const userId = (await createUser(db, 'peter@example.test', randomPassword())).id;
      const add = (title) => Number(db.prepare("INSERT INTO daily_tasks (user_id, title, day, position) VALUES (?, ?, '2026-10-20', 0)").run(userId, title).lastInsertRowid);
      const lab = add('Lab report 3');
      add('Gym');
      db.prepare("INSERT INTO lms_courses (user_id, course_id, name) VALUES (?, 101, 'Stats')").run(userId);
      db.prepare(`INSERT INTO lms_items (user_id, id, course_id, course_name, kind, title, status, task_id, task_made, last_seen_at)
        VALUES (?, 'assign:503', 101, 'Stats', 'assign', 'Lab report 3', 'overdue', ?, 1, '2026-10-20T04:00:00Z')`).run(userId, lab);
      db.exec('ALTER TABLE users DROP COLUMN is_admin'); // back to how version 8 looked
      db.exec('PRAGMA user_version = 8');
      db.close();

      db = openDb(path);
      assert.deepEqual(db.prepare('SELECT title FROM daily_tasks').all().map((r) => r.title), ['Gym']);
      assert.deepEqual({ ...db.prepare('SELECT task_id, task_made FROM lms_items').get() }, { task_id: null, task_made: 0 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('removing a user removes all of their data', async () => {
    const db = openDb(':memory:');
    const user = await createUser(db, 'gwen@example.test', randomPassword());
    const projectId = db.prepare('INSERT INTO projects (user_id, title) VALUES (?, ?)').run(user.id, 'P').lastInsertRowid;
    const stepId = db.prepare('INSERT INTO project_steps (project_id, title) VALUES (?, ?)').run(projectId, 'S').lastInsertRowid;
    db.prepare('INSERT INTO step_items (step_id, title) VALUES (?, ?)').run(stepId, 'I');
    db.prepare("INSERT INTO daily_tasks (user_id, title, day) VALUES (?, 'T', '2026-10-16')").run(user.id);

    removeUser(db, 'GWEN@example.test');
    for (const table of ['users', 'projects', 'project_steps', 'step_items', 'daily_tasks']) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
    }
    db.close();
  });

  test('a repeating task can be added to the same day only once', async () => {
    const db = openDb(':memory:');
    const user = await createUser(db, 'may@example.test', randomPassword());
    const ruleId = db
      .prepare("INSERT INTO repeating_tasks (user_id, title, weekdays) VALUES (?, 'Gym', 127)")
      .run(user.id).lastInsertRowid;
    const add = db.prepare("INSERT INTO daily_tasks (user_id, title, day, repeating_task_id) VALUES (?, 'Gym', '2026-10-16', ?)");
    add.run(user.id, ruleId);
    assert.throws(() => add.run(user.id, ruleId), /UNIQUE/);
    db.close();
  });
});

describe('user command', () => {
  const run = (dbPath, args, input) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli/users.js', ...args], {
      cwd: serverDir,
      env: { ...process.env, DB_PATH: dbPath },
      input,
      encoding: 'utf8',
    });

  test('add, list, admin, passwd and remove work, and the new user can log in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'planner-'));
    const dbPath = join(dir, 'planner.db');
    const password = randomPassword();
    try {
      let r = run(dbPath, ['add', 'Peter@Example.test'], password + '\n');
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Created user peter@example\.test/);

      r = run(dbPath, ['add', 'peter@example.test'], password + '\n');
      assert.equal(r.status, 1);
      assert.match(r.stderr, /already exists/);

      r = run(dbPath, ['add', 'short@example.test'], 'abc\n');
      assert.equal(r.status, 1);
      assert.match(r.stderr, /at least 8/);

      r = run(dbPath, ['list']);
      assert.match(r.stdout, /peter@example\.test/);
      assert.doesNotMatch(r.stdout, /short@/);

      // admin / unadmin, shown in the list.
      r = run(dbPath, ['admin', 'PETER@example.test']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(run(dbPath, ['list']).stdout, /peter@example\.test\tcreated .* UTC\tadmin/);
      r = run(dbPath, ['unadmin', 'peter@example.test']);
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(run(dbPath, ['list']).stdout, /admin/);
      r = run(dbPath, ['admin', 'nobody@example.test']);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /No user/);

      // The password set by the command works for logging in.
      const db = openDb(dbPath);
      const { verifyPassword } = await import('../src/auth/password.js');
      const { password_hash } = db.prepare('SELECT password_hash FROM users').get();
      assert.equal(await verifyPassword(password, password_hash), true);
      db.close();

      const newPassword = randomPassword();
      r = run(dbPath, ['passwd', 'peter@example.test'], newPassword + '\n');
      assert.equal(r.status, 0, r.stderr);

      r = run(dbPath, ['remove', 'peter@example.test']);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /--yes/);

      r = run(dbPath, ['remove', 'peter@example.test', '--yes']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(run(dbPath, ['list']).stdout, /No users yet/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('changing a password logs the user out everywhere', async () => {
    const t = await startTestServer();
    try {
      const email = 'eddie@example.test';
      const password = randomPassword();
      await t.addUser(email, password);
      const res = await t.request('/api/auth/login', { method: 'POST', body: { email, password } });
      const cookie = res.headers.get('set-cookie').split(';')[0];

      const { setPassword } = await import('../src/users.js');
      await setPassword(t.db, email, randomPassword());
      assert.equal((await t.request('/api/auth/me', { cookie })).status, 401);
    } finally {
      await t.close();
    }
  });
});
