import assert from 'node:assert/strict';
import { createECDH, createPublicKey, randomBytes, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';
import webpush from 'web-push';
import { openDb } from '../src/db.js';
import { createNotifier } from '../src/notifications.js';
import { createPush, loadVapidKeys } from '../src/push.js';
import { createUser } from '../src/users.js';
import { loggedIn, randomPassword, startTestServer } from './helpers.js';

// http_ece comes with web-push; used here to decrypt what a real browser would receive.
const ece = createRequire(import.meta.url)('http_ece');

const at = (day, time) => new Date(`${day}T${time}:00+05:30`);
const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** A subscription like a browser makes: its own P-256 key pair and auth secret. */
function fakeBrowser(endpoint = `https://push.example.test/send/${randomBytes(6).toString('hex')}`) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, subscription: { endpoint, keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(auth) } } };
}

/** A `send` that records calls instead of contacting a push service. */
function recorder(fail) {
  const calls = [];
  const send = async (subscription, payload, options) => {
    calls.push({ endpoint: subscription.endpoint, message: JSON.parse(payload), options });
    const status = fail?.(subscription.endpoint);
    if (status) throw Object.assign(new Error('push failed'), { statusCode: status });
  };
  return { calls, send };
}

describe('VAPID keys', () => {
  test('are created once and kept in the database', () => {
    const db = openDb(':memory:');
    const first = loadVapidKeys(db, {});
    assert.match(first.publicKey, /^[A-Za-z0-9_-]{87}$/);
    assert.deepEqual(loadVapidKeys(db, {}), first);
    db.close();
  });

  test('environment keys win', () => {
    const db = openDb(':memory:');
    const env = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' };
    assert.deepEqual(loadVapidKeys(db, env), { publicKey: 'pub', privateKey: 'priv' });
    db.close();
  });
});

describe('push API', () => {
  test('subscribe, count devices, unsubscribe', async () => {
    const t = await startTestServer();
    try {
      const api = await loggedIn(t, 'peter@example.test');
      const other = await loggedIn(t, 'miles@example.test');
      const { subscription } = fakeBrowser();

      let res = await api('GET', '/api/push');
      assert.match(res.body.publicKey, /^[A-Za-z0-9_-]{87}$/);
      assert.equal(res.body.devices, 0);

      res = await api('POST', '/api/push/subscribe', subscription);
      assert.deepEqual(res.body, { devices: 1 });
      res = await api('POST', '/api/push/subscribe', subscription);
      assert.deepEqual(res.body, { devices: 1 }, 'subscribing again does not duplicate');

      // The same device used by the other user afterwards moves to them.
      res = await other('POST', '/api/push/subscribe', subscription);
      assert.deepEqual(res.body, { devices: 1 });
      assert.equal((await api('GET', '/api/push')).body.devices, 0);

      // Someone else's device can't be unsubscribed.
      await api('POST', '/api/push/unsubscribe', { endpoint: subscription.endpoint });
      assert.equal((await other('GET', '/api/push')).body.devices, 1);
      res = await other('POST', '/api/push/unsubscribe', { endpoint: subscription.endpoint });
      assert.deepEqual(res.body, { devices: 0 });
    } finally {
      await t.close();
    }
  });

  test('bad subscriptions are refused, and a test needs a device', async () => {
    const t = await startTestServer();
    try {
      const api = await loggedIn(t, 'peter@example.test');
      const { subscription } = fakeBrowser();
      const bad = [
        { ...subscription, endpoint: 'http://push.example.test/x' },
        { ...subscription, endpoint: 'not a url' },
        { ...subscription, keys: { p256dh: 'has spaces!', auth: subscription.keys.auth } },
        { endpoint: subscription.endpoint },
      ];
      for (const body of bad) assert.equal((await api('POST', '/api/push/subscribe', body)).status, 400, JSON.stringify(body));
      assert.equal((await api('POST', '/api/push/test')).status, 409);
      assert.equal((await t.request('/api/push')).status, 401);
    } finally {
      await t.close();
    }
  });
});

describe('sending', () => {
  test('what is sent decrypts on the device and carries a valid VAPID signature', async () => {
    const db = openDb(':memory:');
    const vapid = loadVapidKeys(db, {});
    const user = await createUser(db, 'peter@example.test', randomPassword());
    const browser = fakeBrowser('https://fcm.googleapis.com/fcm/send/abc123');

    let request;
    // Build the exact request web-push would send, without the network.
    const send = async (subscription, payload, options) => {
      request = webpush.generateRequestDetails(subscription, payload, options);
    };
    const push = createPush(db, { vapid, subject: 'mailto:test@example.test', send });
    push.subscribe(user.id, { endpoint: browser.subscription.endpoint, ...browser.subscription.keys });

    const message = { title: 'Today: 2 tasks', body: 'Gym · Read', url: '/#/', tag: 'morning' };
    assert.deepEqual(await push.sendTo(user.id, message, { ttl: 600 }), { sent: 1, failed: 0 });

    // Payload: aes128gcm-encrypted to the browser's key.
    assert.equal(request.headers['Content-Encoding'], 'aes128gcm');
    assert.equal(request.headers.TTL, 600);
    const plain = ece.decrypt(request.body, { version: 'aes128gcm', privateKey: browser.ecdh, authSecret: browser.auth });
    assert.deepEqual(JSON.parse(plain.toString()), message);

    // Authorization: a JWT for the push service's origin, signed with our private key.
    const [, jwt, key] = request.headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
    assert.equal(key, vapid.publicKey);
    const [header, claims, signature] = jwt.split('.');
    const body = JSON.parse(Buffer.from(claims, 'base64url'));
    assert.equal(body.aud, 'https://fcm.googleapis.com');
    assert.equal(body.sub, 'mailto:test@example.test');
    assert.ok(body.exp > Date.now() / 1000);
    const pub = Buffer.from(vapid.publicKey, 'base64url');
    const jwk = { kty: 'EC', crv: 'P-256', x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)) };
    const ok = verify(
      'sha256',
      Buffer.from(`${header}.${claims}`),
      { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    );
    assert.equal(ok, true);
    db.close();
  });

  test('devices the push service says are gone are forgotten; other failures are kept', async () => {
    const db = openDb(':memory:');
    const user = await createUser(db, 'peter@example.test', randomPassword());
    const gone = fakeBrowser().subscription;
    const flaky = fakeBrowser().subscription;
    const fine = fakeBrowser().subscription;
    const { send } = recorder((endpoint) => (endpoint === gone.endpoint ? 410 : endpoint === flaky.endpoint ? 500 : 0));
    const push = createPush(db, { vapid: loadVapidKeys(db, {}), subject: 'mailto:x@example.test', send });
    for (const s of [gone, flaky, fine]) push.subscribe(user.id, { endpoint: s.endpoint, ...s.keys });

    const realError = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(await push.sendTo(user.id, { title: 'x' }), { sent: 1, failed: 2 });
    } finally {
      console.error = realError;
    }
    assert.equal(push.devices(user.id), 2);
    db.close();
  });
});

describe('daily notifications', () => {
  async function setup() {
    let clock = at('2026-10-15', '12:00');
    const t = await startTestServer({ now: () => clock });
    const api = await loggedIn(t, 'peter@example.test');
    await loggedIn(t, 'miles@example.test'); // a user with no devices: never notified
    const peter = t.db.prepare("SELECT id FROM users WHERE email = 'peter@example.test'").get().id;
    const rec = recorder();
    const push = createPush(t.db, { vapid: loadVapidKeys(t.db, {}), subject: 'mailto:x@example.test', send: rec.send });
    const { subscription } = fakeBrowser();
    push.subscribe(peter, { endpoint: subscription.endpoint, ...subscription.keys });
    const notifier = createNotifier(t.db, { push, now: () => clock });
    return { t, api, notifier, calls: rec.calls, setClock: (d) => (clock = d) };
  }

  test('6 AM: today\'s tasks, the first three, and the Unfinished count', async () => {
    const { t, api, notifier, calls, setClock } = await setup();
    try {
      await api('POST', '/api/repeating', { title: 'Gym', weekdays: ['fri'] });
      for (const title of ['Email Ravi', 'Pay rent', 'Read']) await api('POST', '/api/days/2026-10-16/tasks', { title });
      await api('POST', '/api/days/2026-10-15/tasks', { title: 'Left from Thursday' });
      await api('POST', '/api/goals', { title: 'Spring', tasks: [{ title: 'Build API', dueDay: '2026-10-16' }] });

      setClock(at('2026-10-16', '05:59'));
      t.db.exec("INSERT INTO job_runs (name, run_key) VALUES ('rollover', '2026-10-16')"); // as if rollover ran
      t.db.exec("UPDATE daily_tasks SET status = 'unfinished' WHERE day = '2026-10-15'");
      assert.deepEqual(await notifier.runDue(), [], 'not before 6');

      setClock(at('2026-10-16', '06:00'));
      const results = await notifier.runDue();
      assert.equal(results.length, 1, 'only the user with a device');
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].message, {
        title: 'Today: 5 tasks',
        body: 'Build API · Gym · Email Ravi +2 more\n1 unfinished from earlier days',
        url: '/#/',
        tag: 'morning',
      });
      assert.equal(calls[0].options.TTL, 4 * 60 * 60);

      setClock(at('2026-10-16', '06:01'));
      await notifier.runDue();
      assert.equal(calls.length, 1, 'sent once a day');
    } finally {
      await t.close();
    }
  });

  test('6 AM with nothing planned', async () => {
    const { t, notifier, calls, setClock } = await setup();
    try {
      setClock(at('2026-10-16', '06:30'));
      await notifier.runDue();
      assert.equal(calls[0].message.title, 'Nothing planned for today');
      assert.equal(calls[0].message.body, 'Open the app to plan your day.');
    } finally {
      await t.close();
    }
  });

  test('the morning one is not sent late in the day after downtime', async () => {
    const { t, notifier, calls, setClock } = await setup();
    try {
      setClock(at('2026-10-16', '09:00'));
      await notifier.runDue();
      assert.equal(calls.length, 0);
    } finally {
      await t.close();
    }
  });

  test('11 PM: reminds to plan tomorrow, unless tomorrow already has tasks', async () => {
    const { t, api, notifier, calls, setClock } = await setup();
    try {
      // A repeating task alone doesn't count as planned.
      await api('POST', '/api/repeating', { title: 'Gym', weekdays: ['fri'] });
      await api('GET', '/api/days/2026-10-16');

      setClock(at('2026-10-15', '23:00'));
      await notifier.runDue();
      assert.deepEqual(calls.map((c) => c.message), [
        {
          title: 'Plan tomorrow',
          body: 'Nothing planned for tomorrow yet. Two minutes now saves your morning.',
          url: '/#/plan/2026-10-16',
          tag: 'evening',
        },
      ]);

      await api('POST', '/api/days/2026-10-17/tasks', { title: 'Saturday plan' });
      setClock(at('2026-10-16', '23:30'));
      await notifier.runDue();
      assert.equal(calls.length, 1, 'skipped: Saturday is planned');
      assert.ok(t.db.prepare("SELECT 1 FROM job_runs WHERE name = 'evening' AND run_key = '2026-10-16'").get());
    } finally {
      await t.close();
    }
  });
});
