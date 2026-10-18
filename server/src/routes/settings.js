import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { badRequest } from '../http.js';
import { createSettings } from '../settings.js';
import * as v from '../validate.js';

/** { on?, time? } for one of the daily notifications. `from`–`to` limits the time so "tomorrow" stays clear. */
function notification(value, field, from, to) {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) throw badRequest(`${field} must be an object`);
  const time = value.time === undefined ? undefined : v.time(value.time, `${field}.time`);
  if (time !== undefined && (time < from || time > to)) throw badRequest(`${field}.time must be between ${from} and ${to}`);
  return { on: value.on === undefined ? undefined : v.boolean(value.on, `${field}.on`), time };
}

export function settingsRoutes({ db }) {
  const settings = createSettings(db);
  const router = Router();
  router.use(requireAuth);

  router.get('/notifications', (req, res) => {
    res.json(settings.get(req.user.id));
  });

  // Body: { eveningReminder?: { on?, time? }, morningSummary?: { on?, time? } }
  router.patch('/notifications', (req, res) => {
    const b = req.body ?? {};
    res.json(
      settings.update(req.user.id, {
        // The "plan tomorrow" reminder is for the evening; the summary of the day is for the morning.
        eveningReminder: notification(b.eveningReminder, 'eveningReminder', '12:00', '23:59'),
        morningSummary: notification(b.morningSummary, 'morningSummary', '00:00', '12:00'),
      }),
    );
  });

  return router;
}
