import { createHash, randomBytes } from 'node:crypto';
import express from 'express';

// A small stand-in for Google (OAuth + Gmail API) and Microsoft (OAuth + Graph) so the mail code can be tested
// end to end without real accounts. It checks what the real services check: PKCE, the client secret, bearer
// tokens, and refresh tokens (Microsoft's rotate on every use).

const DAY = 86_400_000;
const sha = (s) => createHash('sha256').update(s).digest('base64url');
const token = (prefix) => `${prefix}-${randomBytes(6).toString('hex')}`;

export async function startFakeProviders({ clientId = 'test-client', clientSecret = 'test-secret' } = {}) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  // ---------- OAuth (both providers) ----------
  const codes = new Map(); // code -> { provider, challenge, email }
  const refreshTokens = new Map(); // refresh token -> { provider, email }
  const accessTokens = new Map(); // access token -> { provider, email }
  const calls = { revoked: [], refreshes: 0, tokenRequests: [], gmail: [] };
  const throttle = { left: 0, kind: '429' };

  function issue(provider, email) {
    const refresh = token(`${provider}-refresh`);
    const access = token(`${provider}-access`);
    refreshTokens.set(refresh, { provider, email });
    accessTokens.set(access, { provider, email });
    return { refresh_token: refresh, access_token: access, expires_in: 3600 };
  }

  const tokenEndpoint = (provider) => (req, res) => {
    const b = req.body;
    calls.tokenRequests.push({ provider, ...b });
    if (b.client_id !== clientId || b.client_secret !== clientSecret) return res.status(401).json({ error: 'invalid_client' });
    if (b.grant_type === 'authorization_code') {
      const c = codes.get(b.code);
      codes.delete(b.code);
      if (!c || c.provider !== provider) return res.status(400).json({ error: 'invalid_grant', error_description: 'bad code' });
      if (sha(b.code_verifier ?? '') !== c.challenge) return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE check failed' });
      return res.json({ ...issue(provider, c.email), scope: provider === 'google' ? 'https://www.googleapis.com/auth/gmail.modify' : 'Mail.ReadWrite' });
    }
    if (b.grant_type === 'refresh_token') {
      calls.refreshes += 1;
      const r = refreshTokens.get(b.refresh_token);
      if (!r || r.provider !== provider) return res.status(400).json({ error: 'invalid_grant', error_description: 'revoked' });
      const access = token(`${provider}-access`);
      accessTokens.set(access, r);
      if (provider === 'microsoft') {
        // Microsoft rotates refresh tokens.
        refreshTokens.delete(b.refresh_token);
        const refresh = token('microsoft-refresh');
        refreshTokens.set(refresh, r);
        return res.json({ access_token: access, refresh_token: refresh, expires_in: 3600 });
      }
      return res.json({ access_token: access, expires_in: 3600 });
    }
    res.status(400).json({ error: 'unsupported_grant_type' });
  };

  const auth = (provider) => (req, res, next) => {
    const t = accessTokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (!t || t.provider !== provider) return res.status(401).json({ error: { code: 401, message: 'Invalid credentials' } });
    req.email = t.email;
    next();
  };

  // The sign-in pages: approve straight away and send the browser back (for trying the app by hand).
  for (const [path, provider] of [['/google/auth', 'google'], ['/ms/auth', 'microsoft']]) {
    app.get(path, (req, res) => {
      const code = token('code');
      codes.set(code, { provider, challenge: req.query.code_challenge, email: provider === 'google' ? gmail.email : graph.email });
      res.redirect(`${req.query.redirect_uri}?${new URLSearchParams({ code, state: req.query.state })}`);
    });
  }

  app.post('/google/token', tokenEndpoint('google'));
  app.post('/ms/token', tokenEndpoint('microsoft'));
  app.post('/google/revoke', (req, res) => {
    calls.revoked.push(req.body.token);
    refreshTokens.delete(req.body.token);
    res.json({});
  });

  // ---------- Gmail ----------
  const gmail = { messages: new Map(), history: [], historyId: 1000, minHistoryId: 0, email: 'peter@gmail.test' };
  const gmailRecord = (type, msg) => gmail.history.push({ id: ++gmail.historyId, type, msg });

  const gmailMeta = (m) => ({
    id: m.id,
    threadId: m.threadId,
    labelIds: [...m.labels],
    snippet: m.snippet,
    internalDate: String(m.date),
    payload: { headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }] },
  });

  const g = express.Router();
  g.use(auth('google'));
  // Throttling like Gmail's: the next `throttle.left` calls answer "slow down" (429, or 403 with a rate-limit reason).
  g.use((req, res, next) => {
    calls.gmail.push(req.path);
    if (throttle.left <= 0) return next();
    throttle.left -= 1;
    res.set('Retry-After', '0');
    if (throttle.kind === '403') {
      return res.status(403).json({ error: { code: 403, message: 'User-rate limit exceeded.', status: 'PERMISSION_DENIED', errors: [{ reason: 'userRateLimitExceeded' }] } });
    }
    res.status(429).json({ error: { code: 429, message: "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'", status: 'RESOURCE_EXHAUSTED' } });
  });
  g.get('/profile', (req, res) => res.json({ emailAddress: req.email, historyId: String(gmail.historyId) }));
  g.get('/messages', (req, res) => {
    const days = Number(/newer_than:(\d+)d/.exec(req.query.q ?? '')?.[1] ?? 9999);
    const all = [...gmail.messages.values()]
      .filter((m) => m.labels.has('INBOX') && m.date >= Date.now() - days * DAY)
      .sort((a, b) => b.date - a.date);
    const start = Number(req.query.pageToken ?? 0);
    const size = Math.min(Number(req.query.maxResults ?? 100), 2); // tiny pages, to exercise paging
    const page = all.slice(start, start + size);
    res.json({ messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), ...(start + size < all.length && { nextPageToken: String(start + size) }) });
  });
  g.get('/messages/:id', (req, res) => {
    const m = gmail.messages.get(req.params.id);
    if (!m) return res.status(404).json({ error: { code: 404, message: 'Not Found' } });
    if (req.query.format === 'full') {
      const html = Buffer.from(m.html ?? '').toString('base64url');
      const text = Buffer.from(m.text ?? '').toString('base64url');
      return res.json({
        ...gmailMeta(m),
        payload: {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }], body: { data: text } },
            ...(m.html ? [{ mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset=UTF-8' }], body: { data: html } }] : []),
          ],
        },
      });
    }
    res.json(gmailMeta(m));
  });
  g.post('/messages/:id/modify', (req, res) => {
    const m = gmail.messages.get(req.params.id);
    if (!m) return res.status(404).json({ error: { code: 404 } });
    for (const l of req.body.addLabelIds ?? []) m.labels.add(l);
    for (const l of req.body.removeLabelIds ?? []) m.labels.delete(l);
    gmailRecord('labelsAdded', m.id);
    res.json(gmailMeta(m));
  });
  g.get('/history', (req, res) => {
    const start = Number(req.query.startHistoryId);
    if (start < gmail.minHistoryId) return res.status(404).json({ error: { code: 404, message: 'Requested entity was not found.' } });
    // Each record shaped like Gmail's: { id, messagesAdded: [{ message: { id } }] }
    const key = { added: 'messagesAdded', deleted: 'messagesDeleted', labelsAdded: 'labelsAdded', labelsRemoved: 'labelsRemoved' };
    const history = gmail.history.filter((h) => h.id > start).map((h) => ({ id: String(h.id), [key[h.type]]: [{ message: { id: h.msg } }] }));
    res.json({ history, historyId: String(gmail.historyId) });
  });
  app.use('/gmail', g);

  // ---------- Microsoft Graph ----------
  const graph = { messages: new Map(), log: [], seq: 0, minSeq: 0, email: 'peter@outlook.test' };
  const graphItem = (m) => ({
    id: m.id,
    subject: m.subject,
    bodyPreview: m.preview,
    receivedDateTime: new Date(m.date).toISOString(),
    isRead: m.isRead,
    flag: { flagStatus: m.flagged ? 'flagged' : 'notFlagged' },
    webLink: `https://outlook.live.com/owa/?ItemID=${m.id}`,
    conversationId: `conv-${m.id}`,
    from: { emailAddress: { name: m.fromName, address: m.fromAddress } },
  });
  const graphChange = (id) => graph.log.push({ seq: ++graph.seq, id });

  const ms = express.Router();
  ms.use(auth('microsoft'));
  ms.get('/me', (req, res) => res.json({ mail: req.email, userPrincipalName: req.email }));
  const base = () => `http://127.0.0.1:${server.address().port}/graph`;
  ms.get('/me/mailFolders/inbox/messages/delta', (req, res) => {
    // First delta: everything since the filter date, in pages of 2, then a deltaLink at the current position.
    const since = /receivedDateTime ge (\S+)/.exec(req.query.$filter ?? '')?.[1];
    const all = [...graph.messages.values()].filter((m) => !since || m.date >= Date.parse(since)).sort((a, b) => b.date - a.date);
    const skip = Number(req.query.skip ?? 0);
    const page = all.slice(skip, skip + 2).map(graphItem);
    if (skip + 2 < all.length) {
      return res.json({ value: page, '@odata.nextLink': `${base()}/me/mailFolders/inbox/messages/delta?$filter=${encodeURIComponent(req.query.$filter ?? '')}&skip=${skip + 2}` });
    }
    res.json({ value: page, '@odata.deltaLink': `${base()}/delta?since=${graph.seq}` });
  });
  ms.get('/delta', (req, res) => {
    const since = Number(req.query.since);
    if (since < graph.minSeq) return res.status(410).json({ error: { code: 'SyncStateNotFound', message: 'gone' } });
    const ids = [...new Set(graph.log.filter((c) => c.seq > since).map((c) => c.id))];
    const value = ids.map((id) => (graph.messages.has(id) ? graphItem(graph.messages.get(id)) : { id, '@removed': { reason: 'deleted' } }));
    res.json({ value, '@odata.deltaLink': `${base()}/delta?since=${graph.seq}` });
  });
  ms.get('/me/messages/:id', (req, res) => {
    const m = graph.messages.get(req.params.id);
    if (!m) return res.status(404).json({ error: { code: 'ErrorItemNotFound' } });
    const html = (req.headers.prefer ?? '').includes('html');
    res.json({ id: m.id, body: { contentType: html ? 'html' : 'text', content: html ? m.html : m.preview } });
  });
  ms.patch('/me/messages/:id', (req, res) => {
    const m = graph.messages.get(req.params.id);
    if (!m) return res.status(404).json({ error: { code: 'ErrorItemNotFound' } });
    if (req.body.flag) m.flagged = req.body.flag.flagStatus === 'flagged';
    graphChange(m.id);
    res.json(graphItem(m));
  });
  app.use('/graph', ms);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;

  let nextId = 1;
  return {
    url,
    calls,
    gmail,
    graph,
    config: {
      google: {
        clientId,
        clientSecret,
        minGapMs: 0,
        endpoints: { authorize: `${url}/google/auth`, token: `${url}/google/token`, revoke: `${url}/google/revoke`, api: `${url}/gmail` },
      },
      microsoft: {
        clientId,
        clientSecret,
        endpoints: { authorize: `${url}/ms/auth`, token: `${url}/ms/token`, api: `${url}/graph` },
      },
    },

    /** Plays the user approving the sign-in page at `authorizeUrl`: returns the code the provider would send back. */
    approve(authorizeUrl, email) {
      const u = new URL(authorizeUrl);
      const provider = u.pathname.startsWith('/google') ? 'google' : 'microsoft';
      const code = token('code');
      codes.set(code, { provider, challenge: u.searchParams.get('code_challenge'), email: email ?? (provider === 'google' ? gmail.email : graph.email) });
      return code;
    },

    /** The next `n` Gmail API calls answer "slow down" (kind '429' or '403'). */
    throttleGmail(n, kind = '429') {
      throttle.left = n;
      throttle.kind = kind;
    },

    /** Makes every current access token stop working (as if they expired). */
    expireAccessTokens: () => accessTokens.clear(),
    /** Revokes every refresh token (password changed / access removed). */
    revokeAll: () => refreshTokens.clear(),
    currentRefreshTokens: () => [...refreshTokens.keys()],

    gmailAdd({ daysAgo = 0, labels = ['INBOX', 'UNREAD'], ...m }) {
      const id = `g${(nextId++).toString(16)}`;
      gmail.messages.set(id, { id, threadId: `t${id}`, date: Date.now() - daysAgo * DAY, labels: new Set(labels), snippet: '', from: 'Someone <someone@example.test>', subject: '(no subject)', ...m });
      gmail.history.push({ id: ++gmail.historyId, type: 'added', msg: id });
      return id;
    },
    gmailLabels(id, { add = [], remove = [] }) {
      const m = gmail.messages.get(id);
      add.forEach((l) => m.labels.add(l));
      remove.forEach((l) => m.labels.delete(l));
      gmail.history.push({ id: ++gmail.historyId, type: add.length ? 'labelsAdded' : 'labelsRemoved', msg: id });
    },
    gmailDelete(id) {
      gmail.messages.delete(id);
      gmail.history.push({ id: ++gmail.historyId, type: 'deleted', msg: id });
    },

    graphAdd({ daysAgo = 0, ...m }) {
      const id = `AAMk${nextId++}`;
      graph.messages.set(id, { id, date: Date.now() - daysAgo * DAY, isRead: false, flagged: false, subject: '(no subject)', preview: '', fromName: 'Someone', fromAddress: 'someone@example.test', html: '<p>hi</p>', ...m });
      graphChange(id);
      return id;
    },
    graphUpdate(id, changes) {
      Object.assign(graph.messages.get(id), changes);
      graphChange(id);
    },
    graphDelete(id) {
      graph.messages.delete(id);
      graphChange(id);
    },

    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
