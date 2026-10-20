import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { cookieFrom, randomPassword, startTestServer } from './helpers.js';

describe('passwords', () => {
  test('a hash verifies only the right password', async () => {
    const pw = randomPassword();
    const hash = await hashPassword(pw);
    assert.match(hash, /^scrypt\$16384\$8\$1\$/);
    assert.equal(await verifyPassword(pw, hash), true);
    assert.equal(await verifyPassword(pw + 'x', hash), false);
  });

  test('the same password hashes differently each time', async () => {
    const pw = randomPassword();
    assert.notEqual(await hashPassword(pw), await hashPassword(pw));
  });
});

describe('auth API', () => {
  let t;
  const email = 'peter@example.test';
  const password = randomPassword();
  const login = (body) => t.request('/api/auth/login', { method: 'POST', body });

  before(async () => {
    t = await startTestServer();
    await t.addUser(email, password);
  });
  after(() => t.close());

  test('health check works without login', async () => {
    const res = await t.request('/api/health');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  test('/me without a session is 401', async () => {
    assert.equal((await t.request('/api/auth/me')).status, 401);
  });

  test('wrong password and unknown email give the same answer', async () => {
    const wrongPw = await login({ email, password: 'not-the-password' });
    const noUser = await login({ email: 'nobody@example.test', password });
    assert.equal(wrongPw.status, 401);
    assert.equal(noUser.status, 401);
    assert.deepEqual(await wrongPw.json(), await noUser.json());
    assert.equal(wrongPw.headers.get('set-cookie'), null);
  });

  test('missing fields are 400', async () => {
    assert.equal((await login({ email })).status, 400);
  });

  test('login sets a safe cookie, /me works, logout ends the session', async () => {
    const res = await login({ email: '  PETER@Example.test ', password });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body.user).sort(), ['email', 'id', 'isAdmin']);
    assert.equal(body.user.email, email);

    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Max-Age=2592000/);
    const cookie = cookieFrom(res);

    const me = await t.request('/api/auth/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.email, email);

    const out = await t.request('/api/auth/logout', { method: 'POST', body: {}, cookie });
    assert.equal(out.status, 204);
    assert.equal((await t.request('/api/auth/me', { cookie })).status, 401);
  });

  test('changing your own password: checks the current one, logs out other devices, keeps this one', async () => {
    const mayPassword = randomPassword();
    await t.addUser('may@example.test', mayPassword);
    const signIn = async (pw) => login({ email: 'may@example.test', password: pw });
    const phone = cookieFrom(await signIn(mayPassword));
    const laptop = cookieFrom(await signIn(mayPassword));
    const change = (cookie, body) => t.request('/api/auth/password', { method: 'POST', cookie, body });

    assert.equal((await change(undefined, { currentPassword: mayPassword, newPassword: randomPassword() })).status, 401);
    assert.equal((await change(laptop, { newPassword: randomPassword() })).status, 400);
    const wrong = await change(laptop, { currentPassword: 'not-it-at-all', newPassword: randomPassword() });
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).error, /current password is wrong/);
    assert.equal((await change(laptop, { currentPassword: mayPassword, newPassword: 'short' })).status, 400);
    assert.equal((await change(laptop, { currentPassword: mayPassword, newPassword: mayPassword })).status, 400);

    const newPassword = randomPassword();
    const res = await change(laptop, { currentPassword: mayPassword, newPassword });
    assert.equal(res.status, 200);
    const laptopNow = cookieFrom(res);
    assert.ok(laptopNow && laptopNow !== laptop);
    assert.equal((await t.request('/api/auth/me', { cookie: laptopNow })).status, 200);
    assert.equal((await t.request('/api/auth/me', { cookie: laptop })).status, 401);
    assert.equal((await t.request('/api/auth/me', { cookie: phone })).status, 401);
    assert.equal((await signIn(mayPassword)).status, 401);
    assert.equal((await signIn(newPassword)).status, 200);
  });

  test('too many wrong current passwords block changing it for a while', async () => {
    const pw = randomPassword();
    await t.addUser('ned@example.test', pw);
    const cookie = cookieFrom(await login({ email: 'ned@example.test', password: pw }));
    const change = (currentPassword) => t.request('/api/auth/password', { method: 'POST', cookie, body: { currentPassword, newPassword: randomPassword() } });
    for (let i = 0; i < 10; i++) assert.equal((await change('wrong-password')).status, 400);
    const blocked = await change(pw);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  });

  test('only a hash of the session token is stored', async () => {
    const cookie = cookieFrom(await login({ email, password }));
    const token = cookie.split('=')[1];
    const rows = t.db.prepare('SELECT token_hash FROM sessions').all();
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.token_hash !== token && /^[0-9a-f]{64}$/.test(r.token_hash)));
  });

  test('an expired session is rejected and removed', async () => {
    t.db.exec('DELETE FROM sessions');
    const cookie = cookieFrom(await login({ email, password }));
    t.db.prepare('UPDATE sessions SET expires_ms = ?').run(Date.now() - 1);
    assert.equal((await t.request('/api/auth/me', { cookie })).status, 401);
    assert.equal(t.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
  });

  test('a session used after a day is extended to a full 30 days', async () => {
    const cookie = cookieFrom(await login({ email, password }));
    const tenDays = 10 * 24 * 60 * 60 * 1000;
    t.db.prepare('UPDATE sessions SET expires_ms = ?').run(Date.now() + tenDays);
    const me = await t.request('/api/auth/me', { cookie });
    assert.equal(me.status, 200);
    assert.match(me.headers.get('set-cookie'), /Max-Age=2592000/);
    const { expires_ms } = t.db.prepare('SELECT expires_ms FROM sessions').get();
    assert.ok(expires_ms > Date.now() + 29 * 24 * 60 * 60 * 1000);
  });

  test('writes that are not JSON are refused (CSRF guard)', async () => {
    const res = await t.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(res.status, 415);
  });

  test('broken JSON is 400', async () => {
    const res = await t.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    // An empty JSON body parses to nothing, which is a missing-fields 400.
    assert.equal(res.status, 400);
    const bad = await fetch(t.baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email":',
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'Invalid JSON' });
  });

  test('unknown API paths are a JSON 404', async () => {
    const res = await t.request('/api/nope');
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Not found' });
  });
});

describe('login rate limit', () => {
  test('after 10 failures the 11th try is blocked, even with the right password', async () => {
    const t = await startTestServer();
    const email = 'miles@example.test';
    const password = randomPassword();
    await t.addUser(email, password);
    try {
      for (let i = 0; i < 10; i++) {
        const res = await t.request('/api/auth/login', { method: 'POST', body: { email, password: 'wrong' } });
        assert.equal(res.status, 401);
      }
      const blocked = await t.request('/api/auth/login', { method: 'POST', body: { email, password } });
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    } finally {
      await t.close();
    }
  });
});
