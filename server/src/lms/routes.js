import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { createRateLimiter } from '../auth/rateLimit.js';
import { HttpError, badRequest } from '../http.js';
import * as v from '../validate.js';

const STATUSES = ['open', 'upcoming', 'overdue', 'missed', 'done', 'all'];

/** A username or password for the LMS: a non-empty string, kept exactly as typed (passwords may have spaces). */
function credential(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`${field} is required`);
  if (value.length > 200) throw badRequest(`${field} is too long`);
  return value;
}

export function lmsRoutes({ lms }) {
  const router = Router();
  // A few wrong passwords in a row could lock the LMS account itself, so the app stops after 5 per 15 minutes.
  const attempts = createRateLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
  router.use(requireAuth);

  router.get('/status', (req, res) => res.json(lms.status(req.user.id)));

  // Body: { username, password }. The password goes to the LMS once and is never stored or logged.
  router.post('/connect', async (req, res) => {
    const b = req.body ?? {};
    const username = credential(b.username, 'username').trim();
    const password = credential(b.password, 'password');
    const key = `lms:${req.user.id}`;
    const wait = attempts.blockedFor(key);
    if (wait > 0) throw new HttpError(429, `Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} min.`);
    try {
      const status = await lms.connect(req.user.id, { username, password });
      attempts.reset(key);
      res.json(status);
    } catch (err) {
      if (err.status === 400) attempts.fail(key);
      throw err;
    }
  });

  router.post('/disconnect', (req, res) => {
    lms.disconnect(req.user.id);
    res.status(204).end();
  });

  // Body: { auto?: true }. "Sync now" waits for the sync; auto (the app was opened) starts one in the background,
  // at most every 10 minutes. Answers the status.
  router.post('/sync', async (req, res) => {
    const auto = req.body?.auto === undefined ? false : v.boolean(req.body.auto, 'auto');
    res.json(await lms.syncUser(req.user.id, { auto }));
  });

  // Body: { semesterStart: 'YYYY-MM-DD' | null }
  router.patch('/settings', (req, res) => {
    const value = req.body?.semesterStart;
    if (value === undefined) throw badRequest('Send semesterStart');
    res.json(lms.setSemesterStart(req.user.id, value === null ? null : v.day(value, 'semesterStart')));
  });

  // ?status=open|upcoming|overdue|missed|done|all (default open: upcoming and overdue)
  router.get('/items', (req, res) => {
    const status = req.query.status ?? 'open';
    if (!STATUSES.includes(status)) throw badRequest(`status must be one of ${STATUSES.join(', ')}`);
    res.json({ items: lms.items(req.user.id, status) });
  });

  router.get('/courses', (req, res) => res.json({ courses: lms.courses(req.user.id) }));

  // Body: { projectId?: id | null, hidden?: boolean }
  router.patch('/courses/:id', (req, res) => {
    const b = req.body ?? {};
    if (b.projectId === undefined && b.hidden === undefined) throw badRequest('Send projectId or hidden');
    res.json(
      lms.updateCourse(req.user.id, v.pathId(req.params.id), {
        projectId: b.projectId === undefined ? undefined : v.optionalId(b.projectId, 'projectId'),
        hidden: b.hidden === undefined ? undefined : v.boolean(b.hidden, 'hidden'),
      }),
    );
  });

  return router;
}
