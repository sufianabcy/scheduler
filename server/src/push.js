import webpush from 'web-push';

/**
 * The VAPID key pair that identifies this server to the browsers' push services. Taken from
 * VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY if set; otherwise created on first start and kept in the database,
 * so existing subscriptions keep working across restarts.
 */
export function loadVapidKeys(db, env = process.env) {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  }
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'vapid'").get();
  if (row) return JSON.parse(row.value);
  const keys = webpush.generateVAPIDKeys();
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('vapid', ?)").run(JSON.stringify(keys));
  return keys;
}

/**
 * Push subscriptions (one per device that turned notifications on) and sending to them.
 * `send` is web-push's sendNotification; tests pass their own.
 */
export function createPush(db, { vapid, subject, send = webpush.sendNotification }) {
  const q = {
    ofUser: db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?'),
    count: db.prepare('SELECT count(*) AS n FROM push_subscriptions WHERE user_id = ?'),
    known: db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ? AND endpoint = ?'),
    // A device that was used by the other user before moves to whoever subscribed it last.
    upsert: db.prepare(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
      ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`),
    removeOwned: db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?'),
    remove: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?'),
  };

  return {
    publicKey: vapid.publicKey,

    devices: (userId) => q.count.get(userId).n,

    /** Whether this device's subscription is saved for the user. */
    knows: (userId, endpoint) => Boolean(q.known.get(userId, endpoint)),

    subscribe(userId, { endpoint, p256dh, auth }) {
      q.upsert.run(userId, endpoint, p256dh, auth);
    },

    unsubscribe(userId, endpoint) {
      q.removeOwned.run(userId, endpoint);
    },

    /**
     * Sends { title, body, url, tag } to every device of the user. Devices the push service says are gone
     * (404/410, e.g. the app was uninstalled) are forgotten. Returns { sent, failed, errors }, where errors
     * says what the push service answered for each failure.
     */
    async sendTo(userId, message, { ttl = 3600 } = {}) {
      let sent = 0;
      let failed = 0;
      const errors = [];
      for (const sub of q.ofUser.all(userId)) {
        try {
          await send(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify(message),
            { TTL: ttl, urgency: 'high', vapidDetails: { subject, ...vapid } },
          );
          sent += 1;
        } catch (err) {
          failed += 1;
          const gone = err.statusCode === 404 || err.statusCode === 410;
          errors.push({ status: err.statusCode ?? null, message: gone ? 'This device unsubscribed; it was removed' : String(err.body || err.message).slice(0, 300) });
          if (gone) q.remove.run(sub.endpoint);
          else console.error(`Push to user ${userId} failed:`, err.statusCode ?? '', err.body ?? err.message);
        }
      }
      return { sent, failed, errors };
    },
  };
}
