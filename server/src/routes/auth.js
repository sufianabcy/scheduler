import { Router } from 'express';
import { DUMMY_HASH, verifyPassword } from '../auth/password.js';
import { SESSION_COOKIE, requireAuth, sessionCookieOptions } from '../auth/middleware.js';
import { createRateLimiter } from '../auth/rateLimit.js';
import { findUserByEmail, normalizeEmail } from '../users.js';

const LOGIN_FAILED = 'Wrong email or password';

export function authRoutes({ db, sessions, config }) {
  const router = Router();
  // 10 failed logins per 15 minutes, counted both per IP address and per email.
  const limiter = createRateLimiter({ max: 10, windowMs: 15 * 60 * 1000 });

  router.post('/login', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    if (!email || typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const keys = [`ip:${req.ip}`, `email:${email}`];
    const wait = Math.max(...keys.map((k) => limiter.blockedFor(k)));
    if (wait > 0) {
      res.set('Retry-After', String(wait));
      return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` });
    }

    const user = findUserByEmail(db, email);
    const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) {
      keys.forEach((k) => limiter.fail(k));
      return res.status(401).json({ error: LOGIN_FAILED });
    }

    limiter.reset(`email:${email}`);
    const token = sessions.create(user.id);
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(config, sessions.lifetimeMs));
    res.json({ user: { id: user.id, email: user.email, isAdmin: user.is_admin === 1 } });
  });

  router.post('/logout', (req, res) => {
    sessions.destroy(req.sessionToken);
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions(config));
    res.status(204).end();
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  return router;
}
