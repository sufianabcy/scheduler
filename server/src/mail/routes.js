import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { createDaily } from '../daily.js';
import { HttpError, badRequest } from '../http.js';
import { dayOf } from '../time.js';
import { renderBody } from './index.js';
import * as v from '../validate.js';

// The mail body is someone else's HTML: it gets its own page with no scripts, no forms, nothing from the network
// (unless you ask for images), framed only by this app, and sandboxed. Remote images also act as read receipts,
// which is why they're off until you tap "Show images".
const bodyCsp = (images) =>
  [
    "default-src 'none'",
    `img-src data: cid:${images ? ' https: http:' : ''}`,
    "style-src 'unsafe-inline'",
    'font-src data:',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
    'sandbox allow-popups allow-popups-to-escape-sandbox allow-same-origin',
  ].join('; ');

/** Where the browser lands after connecting an account: the Connected accounts screen, with a message. */
const back = (res, params) => res.redirect(`/#/mail/accounts?${new URLSearchParams(params)}`);

export function mailRoutes({ db, mail, now }) {
  const daily = createDaily(db);
  const router = Router();

  // These two are browser page loads (not fetch calls), so problems become a redirect with a message, not JSON.
  router.get('/connect/:provider', (req, res) => {
    if (!req.user) return res.redirect('/');
    try {
      res.redirect(mail.connectUrl(req.user.id, req.params.provider));
    } catch (err) {
      back(res, { error: err.message });
    }
  });

  router.get('/callback/:provider', async (req, res) => {
    if (!req.user) return res.redirect('/');
    const str = (x) => (typeof x === 'string' ? x : undefined);
    try {
      const account = await mail.finishConnect(req.user.id, req.params.provider, {
        code: str(req.query.code),
        state: str(req.query.state),
        error: str(req.query.error),
      });
      back(res, { connected: account.email });
    } catch (err) {
      console.error(`Mail connect failed: ${err.status ?? ''} ${err.code ?? err.name}`);
      back(res, { error: err.message });
    }
  });

  router.use(requireAuth);

  router.get('/status', (req, res) => res.json(mail.status()));

  router.get('/accounts', (req, res) => res.json({ accounts: mail.accounts(req.user.id) }));

  router.delete('/accounts/:id', async (req, res) => {
    await mail.disconnect(req.user.id, v.pathId(req.params.id));
    res.status(204).end();
  });

  // "Sync now" (pull to refresh). Answers the accounts with their new sync times.
  router.post('/sync', async (req, res) => {
    res.json({ accounts: await mail.syncUser(req.user.id) });
  });

  // ?view=inbox|starred&account=<id>&before=<receivedAt of the last mail shown>
  router.get('/messages', (req, res) => {
    const view = req.query.view ?? 'inbox';
    if (!['inbox', 'starred'].includes(view)) throw badRequest('view must be inbox or starred');
    const accountId = req.query.account === undefined ? null : v.pathId(req.query.account);
    const before = req.query.before === undefined ? null : String(req.query.before);
    if (before !== null && Number.isNaN(Date.parse(before))) throw badRequest('before must be a date and time');
    res.json(mail.list(req.user.id, { accountId, view, before }));
  });

  router.get('/messages/:id', (req, res) => res.json(mail.message(req.user.id, v.pathId(req.params.id))));

  // Shown inside the app's frame, so problems come back as a short page there rather than as JSON.
  router.get('/messages/:id/body', async (req, res) => {
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': bodyCsp(req.query.images === '1'),
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'no-referrer',
    });
    try {
      res.send(await mail.body(req.user.id, v.pathId(req.params.id)));
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(`Mail body failed: ${err.status ?? ''} ${err.code ?? err.name}`);
      const message = err instanceof HttpError ? err.message : "This mail couldn't be loaded. Try again in a moment.";
      res.status(err instanceof HttpError ? err.status : 502).send(renderBody({ text: message }));
    }
  });

  // Body: { starred: true|false }
  router.post('/messages/:id/star', async (req, res) => {
    const starred = v.boolean(req.body?.starred, 'starred');
    res.json(await mail.star(req.user.id, v.pathId(req.params.id), starred));
  });

  // Body: { title?, day?, priority? } — title defaults to the subject, day to today.
  router.post('/messages/:id/task', (req, res) => {
    const today = dayOf(now());
    const b = req.body ?? {};
    const mailRef = mail.taskLink(req.user.id, v.pathId(req.params.id));
    const day = b.day === undefined ? today : v.day(b.day);
    const title = v.title(b.title ?? (mailRef.subject || '(no subject)').slice(0, 200));
    if (b.priority !== undefined && b.priority !== null && ![1, 2, 3].includes(b.priority)) {
      throw badRequest('priority must be 1, 2, 3 or null');
    }
    const result = daily.addTask(req.user.id, day, { title, priority: b.priority ?? null, mail: mailRef }, today);
    res.status(201).json({ day, ...result });
  });

  return router;
}
