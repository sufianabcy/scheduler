import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { badRequest, conflict } from '../http.js';

/** A browser push endpoint: an https URL from the browser's push service. */
function endpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw badRequest('endpoint must be a URL');
  }
  if (url.protocol !== 'https:' || value.length > 1000) throw badRequest('endpoint must be an https URL');
  return value;
}

/** The subscription keys are short base64url strings. */
function key(value, field, max) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value) || value.length > max) {
    throw badRequest(`${field} is not a valid key`);
  }
  return value;
}

export function pushRoutes({ push }) {
  const router = Router();
  router.use(requireAuth);

  // The key the browser needs to subscribe, and how many of your devices have notifications on.
  router.get('/', (req, res) => {
    res.json({ publicKey: push.publicKey, devices: push.devices(req.user.id) });
  });

  // Body: the browser's PushSubscription as JSON: { endpoint, keys: { p256dh, auth } }
  router.post('/subscribe', (req, res) => {
    const b = req.body ?? {};
    push.subscribe(req.user.id, {
      endpoint: endpoint(b.endpoint),
      p256dh: key(b.keys?.p256dh, 'keys.p256dh', 200),
      auth: key(b.keys?.auth, 'keys.auth', 100),
    });
    res.json({ devices: push.devices(req.user.id) });
  });

  // Body: { endpoint } — is this device's subscription saved for you? (for "Check this device")
  router.post('/status', (req, res) => {
    res.json({ known: push.knows(req.user.id, endpoint(req.body?.endpoint)) });
  });

  // Body: { endpoint }
  router.post('/unsubscribe', (req, res) => {
    push.unsubscribe(req.user.id, endpoint(req.body?.endpoint));
    res.json({ devices: push.devices(req.user.id) });
  });

  router.post('/test', async (req, res) => {
    if (push.devices(req.user.id) === 0) throw conflict('Turn on notifications on this device first');
    const result = await push.sendTo(req.user.id, {
      title: 'Test notification',
      body: 'Notifications work on this device.',
      url: '/#/more',
      tag: 'test',
    });
    res.json(result);
  });

  return router;
}
