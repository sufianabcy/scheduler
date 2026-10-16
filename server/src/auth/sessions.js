import { createHash, randomBytes } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export function createSessionStore(db, { sessionDays }) {
  const lifetimeMs = sessionDays * DAY_MS;

  const insert = db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_ms, expires_ms) VALUES (?, ?, ?, ?)',
  );
  const find = db.prepare(`
    SELECT s.token_hash, s.expires_ms, u.id, u.email
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `);
  const extend = db.prepare('UPDATE sessions SET expires_ms = ? WHERE token_hash = ?');
  const remove = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const removeExpired = db.prepare('DELETE FROM sessions WHERE expires_ms <= ?');

  return {
    lifetimeMs,

    /** Starts a session and returns the raw token for the cookie. */
    create(userId, now = Date.now()) {
      removeExpired.run(now);
      const token = randomBytes(32).toString('base64url');
      insert.run(hashToken(token), userId, now, now + lifetimeMs);
      return token;
    },

    /**
     * Returns { user, renewed } for a valid token, or null. A session in use is pushed forward to a full
     * lifetime once a day, so you stay logged in as long as you open the app at least once a month.
     */
    lookup(token, now = Date.now()) {
      if (!token) return null;
      const tokenHash = hashToken(token);
      const row = find.get(tokenHash);
      if (!row) return null;
      if (row.expires_ms <= now) {
        remove.run(tokenHash);
        return null;
      }
      let renewed = false;
      if (row.expires_ms - now < lifetimeMs - DAY_MS) {
        extend.run(now + lifetimeMs, tokenHash);
        renewed = true;
      }
      return { user: { id: row.id, email: row.email }, renewed };
    },

    destroy(token) {
      if (token) remove.run(hashToken(token));
    },
  };
}
