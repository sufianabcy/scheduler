import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, test } from 'node:test';
import { createTokenBox, loadKey } from '../src/mail/crypto.js';
import { createMail, renderBody } from '../src/mail/index.js';
import { parseAddress, decodeEntities } from '../src/mail/http.js';
import { addDays, dayOf } from '../src/time.js';
import { startFakeProviders } from './fake-mail-providers.js';
import { cookieFrom, randomPassword, startTestServer } from './helpers.js';

const MINUTE = 60_000;

describe('token encryption', () => {
  const key = loadKey(randomBytes(32).toString('base64'));

  test('round trip, a new IV every time', () => {
    const box = createTokenBox(key);
    const a = box.seal('1//refresh-token');
    const b = box.seal('1//refresh-token');
    assert.notEqual(a, b);
    assert.match(a, /^v1\./);
    assert.equal(box.open(a), '1//refresh-token');
    assert.ok(!a.includes('refresh-token'));
  });

  test('a changed value or another key is refused', () => {
    const box = createTokenBox(key);
    const sealed = box.seal('secret');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    assert.throws(() => box.open(parts.join('.')));
    assert.throws(() => createTokenBox(loadKey(randomBytes(32).toString('base64'))).open(sealed));
  });

  test('the key must be 32 bytes; no key switches Mail off', () => {
    assert.equal(loadKey(undefined), null);
    assert.throws(() => loadKey(randomBytes(16).toString('base64')), /32 bytes/);
  });
});

describe('helpers', () => {
  test('From headers and Gmail snippets', () => {
    assert.deepEqual(parseAddress('"Ravi K" <ravi@example.com>'), { name: 'Ravi K', address: 'ravi@example.com' });
    assert.deepEqual(parseAddress('ravi@example.com'), { name: null, address: 'ravi@example.com' });
    assert.equal(decodeEntities('It&#39;s &quot;done&quot; &amp; paid &#x2713;'), 'It\'s "done" & paid ✓');
  });

  test('plain-text mail is escaped inside the page', () => {
    const page = renderBody({ text: '<script>alert(1)</script> & more' });
    assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; more'));
    assert.ok(page.includes('<base target="_blank">'));
  });
});

/** A test app with Mail pointed at the fake providers, a clock we can move, and a logged-in user. */
async function setup() {
  const fake = await startFakeProviders();
  const clock = { now: new Date() };
  const tokenKey = randomBytes(32).toString('base64');
  const t = await startTestServer({
    now: () => clock.now,
    mail: (db) => createMail(db, { config: { port: 0, mail: { tokenKey, publicUrl: 'http://app.test', ...fake.config } }, now: () => clock.now }),
  });
  const login = async (email) => {
    const password = randomPassword();
    await t.addUser(email, password);
    const res = await t.request('/api/auth/login', { method: 'POST', body: { email, password } });
    const cookie = cookieFrom(res);
    const api = async (method, path, body) => {
      const r = await t.request(path, { method, cookie, body: method === 'GET' ? undefined : (body ?? {}) });
      const type = r.headers.get('content-type') ?? '';
      return { status: r.status, headers: r.headers, body: r.status === 204 ? null : type.includes('json') ? await r.json() : await r.text() };
    };
    return { cookie, api };
  };
  const peter = await login('peter@example.test');
  return {
    fake,
    t,
    clock,
    tokenKey,
    peter,
    login,
    /** Goes through the whole connect flow in the browser's place. Returns where the app sends the browser at the end. */
    async connect(user, provider, email) {
      const start = await fetch(`${t.baseUrl}/api/mail/connect/${provider}`, { headers: { Cookie: user.cookie }, redirect: 'manual' });
      assert.equal(start.status, 302);
      const authUrl = new URL(start.headers.get('location'));
      const code = fake.approve(authUrl.href, email);
      const back = await fetch(`${t.baseUrl}/api/mail/callback/${provider}?code=${code}&state=${authUrl.searchParams.get('state')}`, {
        headers: { Cookie: user.cookie },
        redirect: 'manual',
      });
      await t.mail.settled();
      return { authUrl, location: back.headers.get('location') };
    },
    /** Moves the clock past the 5-minute sync interval and runs the timer's sync. */
    async tick() {
      clock.now = new Date(clock.now.getTime() + 6 * MINUTE);
      await t.mail.runDue();
    },
    close: async () => {
      await t.close();
      await fake.close();
    },
  };
}

describe('mail: switched off', () => {
  test('without MAIL_TOKEN_KEY, Mail says so and connecting explains why', async () => {
    const t = await startTestServer();
    try {
      const password = randomPassword();
      await t.addUser('peter@example.test', password);
      const cookie = cookieFrom(await t.request('/api/auth/login', { method: 'POST', body: { email: 'peter@example.test', password } }));
      const status = await (await t.request('/api/mail/status', { cookie })).json();
      assert.equal(status.enabled, false);
      assert.equal(status.providers.google.enabled, false);
      const res = await fetch(`${t.baseUrl}/api/mail/connect/google`, { headers: { Cookie: cookie }, redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.match(decodeURIComponent(res.headers.get('location')), /MAIL_TOKEN_KEY/);
      assert.equal((await t.request('/api/mail/status')).status, 401);
    } finally {
      await t.close();
    }
  });
});

describe('mail: Gmail', () => {
  let s;
  afterEach(() => s?.close());

  test('connect: sign-in URL, PKCE, encrypted token, first sync of the last 30 days of inbox', async () => {
    s = await setup();
    const { fake, t, peter } = s;
    fake.gmailAdd({ subject: 'Invoice Oct', from: '"Ravi K" <ravi@example.test>', snippet: 'It&#39;s due Friday', daysAgo: 1 });
    fake.gmailAdd({ subject: 'Read already', labels: ['INBOX'], daysAgo: 2 });
    fake.gmailAdd({ subject: 'Starred one', labels: ['INBOX', 'STARRED'], daysAgo: 3 });
    fake.gmailAdd({ subject: 'Archived', labels: [], daysAgo: 1 });
    fake.gmailAdd({ subject: 'Too old', daysAgo: 45 });

    const { authUrl, location } = await s.connect(peter, 'google');
    assert.equal(authUrl.searchParams.get('redirect_uri'), 'http://app.test/api/mail/callback/google');
    assert.equal(authUrl.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.modify');
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authUrl.searchParams.get('access_type'), 'offline');
    assert.equal(location, '/#/mail/accounts?connected=peter%40gmail.test');

    // The refresh token is stored encrypted, never as plain text.
    const row = t.db.prepare('SELECT refresh_token FROM mail_accounts').get();
    const [refresh] = fake.currentRefreshTokens();
    assert.ok(!row.refresh_token.includes(refresh));
    assert.equal(createTokenBox(loadKey(s.tokenKey)).open(row.refresh_token), refresh);

    const { body } = await peter.api('GET', '/api/mail/messages');
    assert.deepEqual(body.messages.map((m) => m.subject), ['Invoice Oct', 'Read already', 'Starred one']);
    const invoice = body.messages[0];
    assert.equal(invoice.fromName, 'Ravi K');
    assert.equal(invoice.fromAddress, 'ravi@example.test');
    assert.equal(invoice.snippet, "It's due Friday");
    assert.equal(invoice.unread, true);
    assert.equal(invoice.account, 'peter@gmail.test');
    assert.match(invoice.webLink, /^https:\/\/mail\.google\.com\/mail\/\?authuser=peter%40gmail\.test#all\//);
    assert.equal(body.messages[1].unread, false);
    assert.equal(body.messages[2].starred, true);

    const accounts = (await peter.api('GET', '/api/mail/accounts')).body.accounts;
    assert.deepEqual(accounts.map((a) => [a.provider, a.email, a.status, a.unread, a.starred, a.color]), [['google', 'peter@gmail.test', 'ok', 1, 1, 1]]);
  });

  test('a sign-in started by someone else, or a wrong state, is refused', async () => {
    s = await setup();
    const { fake, t, peter } = s;
    const miles = await s.login('miles@example.test');
    const start = await fetch(`${t.baseUrl}/api/mail/connect/google`, { headers: { Cookie: peter.cookie }, redirect: 'manual' });
    const authUrl = new URL(start.headers.get('location'));
    const code = fake.approve(authUrl.href);
    const state = authUrl.searchParams.get('state');

    // Miles can't finish Peter's sign-in.
    let res = await fetch(`${t.baseUrl}/api/mail/callback/google?code=${code}&state=${state}`, { headers: { Cookie: miles.cookie }, redirect: 'manual' });
    assert.match(new URLSearchParams(res.headers.get('location').split('?')[1]).get('error'), /expired or was not started here/);
    res = await fetch(`${t.baseUrl}/api/mail/callback/google?code=${code}&state=made-up`, { headers: { Cookie: peter.cookie }, redirect: 'manual' });
    assert.match(res.headers.get('location'), /error=/);
    // Cancelling at Google.
    res = await fetch(`${t.baseUrl}/api/mail/callback/google?error=access_denied&state=${state}`, { headers: { Cookie: peter.cookie }, redirect: 'manual' });
    assert.equal(new URLSearchParams(res.headers.get('location').split('?')[1]).get('error'), 'Sign-in was cancelled');
    assert.equal(t.db.prepare('SELECT count(*) AS n FROM mail_accounts').get().n, 0);
    // Not logged in: back to the app's front page.
    res = await fetch(`${t.baseUrl}/api/mail/connect/google`, { redirect: 'manual' });
    assert.equal(res.headers.get('location'), '/');
  });

  test('change sync: new mail, read, starred in Gmail, archived and deleted', async () => {
    s = await setup();
    const { fake, peter } = s;
    const a = fake.gmailAdd({ subject: 'A' });
    const b = fake.gmailAdd({ subject: 'B' });
    const c = fake.gmailAdd({ subject: 'C' });
    await s.connect(peter, 'google');
    const before = fake.calls.tokenRequests.length;

    fake.gmailAdd({ subject: 'New one' });
    fake.gmailLabels(a, { remove: ['UNREAD'] });
    fake.gmailLabels(b, { add: ['STARRED'] });
    fake.gmailLabels(c, { remove: ['INBOX'] });
    const d = fake.gmailAdd({ subject: 'Gone soon' });
    fake.gmailDelete(d);

    // Not due yet: nothing happens.
    await s.t.mail.runDue();
    assert.equal((await peter.api('GET', '/api/mail/messages')).body.messages.length, 3);

    await s.tick();
    const { messages } = (await peter.api('GET', '/api/mail/messages')).body;
    assert.deepEqual(messages.map((m) => m.subject).sort(), ['A', 'B', 'New one']);
    assert.equal(messages.find((m) => m.subject === 'A').unread, false);
    assert.equal(messages.find((m) => m.subject === 'B').starred, true);
    // The access token from connecting was still good: no refresh was needed.
    assert.equal(fake.calls.tokenRequests.length, before);

    const starred = (await peter.api('GET', '/api/mail/messages?view=starred')).body.messages;
    assert.deepEqual(starred.map((m) => m.subject), ['B']);
  });

  test('an old history position falls back to a full sync', async () => {
    s = await setup();
    const { fake, peter } = s;
    const a = fake.gmailAdd({ subject: 'Stays' });
    const b = fake.gmailAdd({ subject: 'Archived while away' });
    await s.connect(peter, 'google');
    fake.gmailLabels(b, { remove: ['INBOX'] });
    fake.gmailAdd({ subject: 'Arrived while away' });
    fake.gmail.minHistoryId = fake.gmail.historyId + 1; // Gmail forgot our position
    await s.tick();
    const subjects = (await peter.api('GET', '/api/mail/messages')).body.messages.map((m) => m.subject).sort();
    assert.deepEqual(subjects, ['Arrived while away', 'Stays']);
    assert.ok(a);
  });

  test('expired access token is refreshed; a revoked one marks the account for reconnecting', async () => {
    s = await setup();
    const { fake, peter, t } = s;
    fake.gmailAdd({ subject: 'Hello' });
    await s.connect(peter, 'google');
    const accountId = (await peter.api('GET', '/api/mail/accounts')).body.accounts[0].id;

    fake.expireAccessTokens();
    fake.gmailAdd({ subject: 'After expiry' });
    await s.tick();
    assert.equal(fake.calls.refreshes, 1);
    assert.equal((await peter.api('GET', '/api/mail/messages')).body.messages.length, 2);

    fake.expireAccessTokens();
    fake.revokeAll();
    const realError = console.error;
    console.error = () => {};
    try {
      await s.tick();
    } finally {
      console.error = realError;
    }
    let account = (await peter.api('GET', '/api/mail/accounts')).body.accounts[0];
    assert.equal(account.status, 'needs_reconnect');
    assert.match(account.lastError, /connect the account again/);
    // Its mail stays visible; reading a body asks to reconnect.
    const id = (await peter.api('GET', '/api/mail/messages')).body.messages[0].id;
    assert.equal((await peter.api('GET', `/api/mail/messages/${id}/body`)).status, 409);

    // Connecting the same address again fixes it, keeping the same account.
    await s.connect(peter, 'google');
    account = (await peter.api('GET', '/api/mail/accounts')).body.accounts[0];
    assert.equal(account.id, accountId);
    assert.equal(account.status, 'ok');
    assert.equal(t.db.prepare('SELECT count(*) AS n FROM mail_accounts').get().n, 1);
  });

  test('the body is fetched live, framed safely, images off unless asked', async () => {
    s = await setup();
    const { fake, peter, t } = s;
    fake.gmailAdd({ subject: 'Newsletter', html: '<p>Hi <b>Peter</b></p><img src="https://tracker.example/p.gif">', text: 'Hi Peter' });
    fake.gmailAdd({ subject: 'Plain', text: 'Line 1\n<not a tag>' });
    await s.connect(peter, 'google');
    const [plain, html] = (await peter.api('GET', '/api/mail/messages')).body.messages;

    let res = await peter.api('GET', `/api/mail/messages/${html.id}/body`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.ok(res.body.includes('<p>Hi <b>Peter</b></p>'));
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /img-src data: cid:;/);
    assert.match(csp, /sandbox allow-popups/);
    assert.doesNotMatch(csp, /allow-scripts/);
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');

    res = await peter.api('GET', `/api/mail/messages/${html.id}/body?images=1`);
    assert.match(res.headers.get('content-security-policy'), /img-src data: cid: https: http:/);

    res = await peter.api('GET', `/api/mail/messages/${plain.id}/body`);
    assert.ok(res.body.includes('Line 1\n&lt;not a tag&gt;'));
    // Bodies are never stored.
    assert.ok(!JSON.stringify(t.db.prepare('SELECT * FROM mail_messages').all()).includes('Hi Peter'));
  });

  test('starring in the app stars it in Gmail; starred mail outlives the 30-day clean-up', async () => {
    s = await setup();
    const { fake, peter } = s;
    const gid = fake.gmailAdd({ subject: 'Keep me', daysAgo: 25 });
    fake.gmailAdd({ subject: 'Let go', daysAgo: 25 });
    await s.connect(peter, 'google');
    const keep = (await peter.api('GET', '/api/mail/messages')).body.messages.find((m) => m.subject === 'Keep me');

    const res = await peter.api('POST', `/api/mail/messages/${keep.id}/star`, { starred: true });
    assert.equal(res.body.starred, true);
    assert.ok(fake.gmail.messages.get(gid).labels.has('STARRED'));

    s.clock.now = new Date(s.clock.now.getTime() + 10 * 86_400_000);
    await s.t.mail.runDue();
    const subjects = (await peter.api('GET', '/api/mail/messages')).body.messages.map((m) => m.subject);
    assert.deepEqual(subjects, ['Keep me']);
    assert.equal((await peter.api('POST', `/api/mail/messages/${keep.id}/star`, { starred: 'yes' })).status, 400);
  });

  test('make a task from a mail; it keeps its link after the mail is gone', async () => {
    s = await setup();
    const { fake, peter } = s;
    fake.gmailAdd({ subject: 'Pay the electricity bill' });
    await s.connect(peter, 'google');
    const mail = (await peter.api('GET', '/api/mail/messages')).body.messages[0];
    const tomorrow = addDays(dayOf(s.clock.now), 1);

    let res = await peter.api('POST', `/api/mail/messages/${mail.id}/task`, { day: tomorrow, priority: 1 });
    assert.equal(res.status, 201);
    const task = res.body.tasks.find((x) => x.title === 'Pay the electricity bill');
    assert.deepEqual(task.mail, { messageId: mail.id, link: mail.webLink });
    assert.equal(task.priority, 1);

    res = await peter.api('POST', `/api/mail/messages/${mail.id}/task`, { title: 'Call Ravi about it' });
    assert.equal(res.body.day, dayOf(s.clock.now));
    assert.ok(res.body.tasks.some((x) => x.title === 'Call Ravi about it' && x.mail?.messageId === mail.id));

    // Disconnecting removes the synced mail; the task keeps its link to Gmail.
    assert.equal((await peter.api('DELETE', `/api/mail/accounts/${mail.accountId}`)).status, 204);
    assert.equal(fake.calls.revoked.length, 1);
    const day = (await peter.api('GET', `/api/days/${tomorrow}`)).body.tasks[0];
    assert.deepEqual(day.mail, { messageId: null, link: mail.webLink });
    assert.equal((await peter.api('GET', '/api/mail/messages')).body.messages.length, 0);
    assert.equal((await peter.api('GET', '/api/mail/accounts')).body.accounts.length, 0);
  });

  test("another user can't see or touch your mail", async () => {
    s = await setup();
    const { fake, peter } = s;
    fake.gmailAdd({ subject: 'Private' });
    await s.connect(peter, 'google');
    const mail = (await peter.api('GET', '/api/mail/messages')).body.messages[0];
    const miles = await s.login('miles@example.test');
    assert.deepEqual((await miles.api('GET', '/api/mail/messages')).body.messages, []);
    assert.deepEqual((await miles.api('GET', '/api/mail/accounts')).body.accounts, []);
    for (const [method, path, body] of [
      ['GET', `/api/mail/messages/${mail.id}`],
      ['GET', `/api/mail/messages/${mail.id}/body`],
      ['POST', `/api/mail/messages/${mail.id}/star`, { starred: true }],
      ['POST', `/api/mail/messages/${mail.id}/task`, {}],
      ['DELETE', `/api/mail/accounts/${mail.accountId}`],
    ]) {
      assert.equal((await miles.api(method, path, body)).status, 404, `${method} ${path}`);
    }
    assert.equal((await miles.api('GET', `/api/mail/messages?account=${mail.accountId}`)).body.messages.length, 0);
  });

  test('when Gmail says slow down, the sync waits and tries again', async () => {
    s = await setup();
    const { fake, peter } = s;
    for (let i = 0; i < 4; i++) fake.gmailAdd({ subject: `Mail ${i}` });
    fake.throttleGmail(2); // 429 "Quota exceeded … per minute per user"
    await s.connect(peter, 'google');
    let account = (await peter.api('GET', '/api/mail/accounts')).body.accounts[0];
    assert.equal(account.lastError, null);
    assert.equal((await peter.api('GET', '/api/mail/messages')).body.messages.length, 4);

    fake.gmailAdd({ subject: 'After a 403' });
    fake.throttleGmail(2, '403'); // 403 userRateLimitExceeded
    await s.tick();
    account = (await peter.api('GET', '/api/mail/accounts')).body.accounts[0];
    assert.equal(account.lastError, null);
    assert.equal((await peter.api('GET', '/api/mail/messages')).body.messages.length, 5);
  });

  test('if Gmail keeps saying slow down, the account says so plainly and the next sync catches up', async () => {
    s = await setup();
    const { fake, peter } = s;
    fake.gmailAdd({ subject: 'Hello' });
    await s.connect(peter, 'google');
    fake.gmailAdd({ subject: 'Waiting' });
    fake.throttleGmail(100);
    const realError = console.error;
    console.error = () => {};
    try {
      await s.tick();
    } finally {
      console.error = realError;
    }
    let account = (await peter.api('GET', '/api/mail/accounts')).body.accounts[0];
    assert.equal(account.status, 'ok');
    assert.equal(account.lastError, 'Gmail asked the app to slow down. It tries again by itself in a few minutes.');

    fake.throttleGmail(0);
    await s.tick();
    account = (await peter.api('GET', '/api/mail/accounts')).body.accounts[0];
    assert.equal(account.lastError, null);
    assert.equal((await peter.api('GET', '/api/mail/messages')).body.messages.length, 2);
  });

  test('the same account is never synced twice at once', async () => {
    s = await setup();
    const { fake, peter, t } = s;
    fake.gmailAdd({ subject: 'One' });
    await s.connect(peter, 'google');
    const id = (await peter.api('GET', '/api/mail/accounts')).body.accounts[0].id;
    fake.gmailAdd({ subject: 'Two' });
    const before = fake.calls.gmail.filter((p) => p === '/history').length;
    await Promise.all([t.mail.syncAccount({ id }), t.mail.syncAccount({ id }), t.mail.syncAccount({ id })]);
    assert.equal(fake.calls.gmail.filter((p) => p === '/history').length - before, 1);
    assert.equal((await peter.api('GET', '/api/mail/messages')).body.messages.length, 2);
  });

  test('sync now, paging and filters', async () => {
    s = await setup();
    const { fake, peter } = s;
    for (let i = 0; i < 5; i++) fake.gmailAdd({ subject: `Mail ${i}`, daysAgo: i });
    await s.connect(peter, 'google');
    fake.gmailAdd({ subject: 'Just now' });
    // Sync now skips an account synced in the last 20 seconds, then works.
    let res = await peter.api('POST', '/api/mail/sync');
    assert.equal(res.body.accounts[0].unread, 5);
    s.clock.now = new Date(s.clock.now.getTime() + 30_000);
    res = await peter.api('POST', '/api/mail/sync');
    assert.equal(res.body.accounts[0].unread, 6);

    const all = (await peter.api('GET', '/api/mail/messages')).body;
    assert.equal(all.messages.length, 6);
    assert.equal(all.hasMore, false);
    const older = (await peter.api('GET', `/api/mail/messages?before=${encodeURIComponent(all.messages[2].receivedAt)}`)).body;
    assert.deepEqual(older.messages.map((m) => m.subject), all.messages.slice(3).map((m) => m.subject));
    assert.equal((await peter.api('GET', '/api/mail/messages?view=junk')).status, 400);
    assert.equal((await peter.api('GET', '/api/mail/messages?before=yesterday')).status, 400);
  });
});

describe('mail: Outlook', () => {
  let s;
  afterEach(() => s?.close());

  test('connect, paged first sync, changes, flags, rotating refresh tokens, expired delta', async () => {
    s = await setup();
    const { fake, peter, t } = s;
    const a = fake.graphAdd({ subject: 'Team lunch', fromName: 'Gwen', fromAddress: 'gwen@example.test', preview: 'Friday 1pm' });
    const b = fake.graphAdd({ subject: 'Flight', daysAgo: 2 });
    fake.graphAdd({ subject: 'Old', daysAgo: 40 });
    fake.graphAdd({ subject: 'Third', daysAgo: 3, isRead: true });

    const { authUrl } = await s.connect(peter, 'microsoft');
    assert.equal(authUrl.searchParams.get('scope'), 'offline_access User.Read Mail.ReadWrite');
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    let { messages } = (await peter.api('GET', '/api/mail/messages')).body;
    assert.deepEqual(messages.map((m) => m.subject), ['Team lunch', 'Flight', 'Third']);
    assert.equal(messages[0].fromName, 'Gwen');
    assert.equal(messages[0].snippet, 'Friday 1pm');
    assert.equal(messages[2].unread, false);
    assert.equal(messages[0].provider, 'microsoft');

    // Changes: read in Outlook, flagged, deleted, new mail.
    fake.graphUpdate(a, { isRead: true, flagged: true });
    fake.graphDelete(b);
    fake.graphAdd({ subject: 'Brand new' });
    fake.expireAccessTokens(); // forces a refresh, which rotates the refresh token
    const sealedBefore = t.db.prepare('SELECT refresh_token FROM mail_accounts').get().refresh_token;
    await s.tick();
    ({ messages } = (await peter.api('GET', '/api/mail/messages')).body);
    assert.deepEqual(messages.map((m) => m.subject), ['Brand new', 'Team lunch', 'Third']);
    assert.equal(messages[1].starred, true);
    assert.equal(messages[1].unread, false);
    const sealedAfter = t.db.prepare('SELECT refresh_token FROM mail_accounts').get().refresh_token;
    assert.notEqual(sealedAfter, sealedBefore);
    assert.deepEqual([createTokenBox(loadKey(s.tokenKey)).open(sealedAfter)], fake.currentRefreshTokens());

    // Flag from the app.
    const third = messages.find((m) => m.subject === 'Third');
    await peter.api('POST', `/api/mail/messages/${third.id}/star`, { starred: true });
    assert.equal(fake.graph.messages.get([...fake.graph.messages.keys()].find((k) => fake.graph.messages.get(k).subject === 'Third')).flagged, true);

    // Body.
    const body = await peter.api('GET', `/api/mail/messages/${messages[1].id}/body`);
    assert.ok(body.body.includes('<p>hi</p>'));

    // Microsoft forgets the delta position: full sync again.
    fake.graph.minSeq = fake.graph.seq + 1;
    fake.graphAdd({ subject: 'After reset' });
    await s.tick();
    ({ messages } = (await peter.api('GET', '/api/mail/messages')).body);
    assert.ok(messages.some((m) => m.subject === 'After reset'));
    assert.equal(messages.length, 4);
  });

  test('Gmail and Outlook side by side: colours, account filter, starred view', async () => {
    s = await setup();
    const { fake, peter } = s;
    fake.gmailAdd({ subject: 'From Gmail', labels: ['INBOX', 'STARRED'] });
    fake.graphAdd({ subject: 'From Outlook', flagged: true, daysAgo: 1 });
    await s.connect(peter, 'google');
    await s.connect(peter, 'microsoft');
    const accounts = (await peter.api('GET', '/api/mail/accounts')).body.accounts;
    assert.deepEqual(accounts.map((a) => [a.provider, a.color]), [['google', 1], ['microsoft', 2]]);
    const all = (await peter.api('GET', '/api/mail/messages')).body.messages;
    assert.deepEqual(all.map((m) => m.subject), ['From Gmail', 'From Outlook']);
    const outlookOnly = (await peter.api('GET', `/api/mail/messages?account=${accounts[1].id}`)).body.messages;
    assert.deepEqual(outlookOnly.map((m) => m.subject), ['From Outlook']);
    const starred = (await peter.api('GET', '/api/mail/messages?view=starred')).body.messages;
    assert.equal(starred.length, 2);
  });
});
