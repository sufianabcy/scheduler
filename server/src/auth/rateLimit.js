/**
 * Small in-memory limiter for login attempts. Counts failures per key (IP address, email) in a fixed window.
 * Kept in memory on purpose: with one server process, nothing else is needed.
 */
export function createRateLimiter({ max, windowMs }) {
  const hits = new Map();

  const current = (key, now) => {
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) return null;
    return entry;
  };

  return {
    /** Seconds until the key may try again, or 0 if it isn't blocked. */
    blockedFor(key, now = Date.now()) {
      const entry = current(key, now);
      return entry && entry.count >= max ? Math.ceil((entry.resetAt - now) / 1000) : 0;
    },

    fail(key, now = Date.now()) {
      const entry = current(key, now) ?? { count: 0, resetAt: now + windowMs };
      entry.count += 1;
      hits.set(key, entry);
      if (hits.size > 10_000) {
        for (const [k, e] of hits) if (e.resetAt <= now) hits.delete(k);
      }
    },

    reset(key) {
      hits.delete(key);
    },
  };
}
