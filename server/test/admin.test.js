import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { setAdmin } from '../src/users.js';
import { loggedIn, randomPassword, startTestServer } from './helpers.js';

describe('admin: creating users in the app', () => {
  let t;
  let admin;
  let peter;

  before(async () => {
    t = await startTestServer();
    peter = await loggedIn(t, 'peter@example.test');
    admin = await loggedIn(t, 'tony@example.test');
    setAdmin(t.db, 'tony@example.test', true);
  });
  after(() => t.close());

  test('/me says who is an admin', async () => {
    assert.equal((await admin('GET', '/api/auth/me')).body.user.isAdmin, true);
    assert.equal((await peter('GET', '/api/auth/me')).body.user.isAdmin, false);
  });

  test('an admin creates a user, who can then log in', async () => {
    const password = randomPassword();
    const res = await admin('POST', '/api/admin/users', { email: ' May@Example.test ', password });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.email, 'may@example.test');
    assert.equal(res.body.user.isAdmin, false);

    const list = (await admin('GET', '/api/admin/users')).body.users;
    assert.deepEqual(list.map((u) => [u.email, u.isAdmin]), [['peter@example.test', false], ['tony@example.test', true], ['may@example.test', false]]);

    const login = await t.request('/api/auth/login', { method: 'POST', body: { email: 'may@example.test', password } });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).user.isAdmin, false);
  });

  test('bad input and an email already in use are refused', async () => {
    assert.equal((await admin('POST', '/api/admin/users', { email: 'not-an-email', password: randomPassword() })).status, 400);
    assert.equal((await admin('POST', '/api/admin/users', { email: 'ned@example.test', password: 'short' })).status, 400);
    assert.equal((await admin('POST', '/api/admin/users', { email: 'ned@example.test', password: 'x'.repeat(201) })).status, 400);
    const taken = await admin('POST', '/api/admin/users', { email: 'PETER@example.test', password: randomPassword() });
    assert.equal(taken.status, 409);
  });

  test('anyone else is turned away, and losing admin takes effect at once', async () => {
    assert.equal((await peter('GET', '/api/admin/users')).status, 403);
    assert.equal((await peter('POST', '/api/admin/users', { email: 'ned@example.test', password: randomPassword() })).status, 403);
    assert.equal((await t.request('/api/admin/users')).status, 401);

    setAdmin(t.db, 'tony@example.test', false);
    assert.equal((await admin('GET', '/api/admin/users')).status, 403);
    setAdmin(t.db, 'tony@example.test', true);
    assert.equal((await admin('GET', '/api/admin/users')).status, 200);
  });
});
