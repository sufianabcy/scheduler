import { transaction } from '../db.js';
import { HttpError, badRequest, notFound } from '../http.js';
import { createTokenBox, loadKey } from './crypto.js';
import { createGmail } from './gmail.js';
import { createGraph } from './graph.js';
import { CursorExpired, ProviderError, isRateLimited } from './http.js';
import { createOAuth } from './oauth.js';

export const SYNC_DAYS = 30;
export const KEEP_PER_ACCOUNT = 500;
export const SYNC_EVERY_MS = 5 * 60 * 1000;
const COLORS = 6;
const LIST_LIMIT = 50;

/** The account's token no longer works (password changed, access removed): the user has to connect it again. */
export class NeedsReconnect extends Error {}

const accountJson = (a, label, counts = {}) => ({
  id: a.id,
  provider: a.provider,
  providerLabel: label,
  email: a.email,
  color: a.color,
  status: a.status,
  lastSyncedAt: a.last_synced_at,
  lastError: a.last_error,
  unread: counts.unread ?? 0,
  starred: counts.starred ?? 0,
});

const messageJson = (m) => ({
  id: m.id,
  accountId: m.account_id,
  provider: m.provider,
  account: m.email,
  color: m.color,
  fromName: m.from_name,
  fromAddress: m.from_address,
  subject: m.subject,
  snippet: m.snippet,
  receivedAt: m.received_at,
  unread: m.unread === 1,
  starred: m.starred === 1,
  webLink: m.web_link,
});

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Wraps a mail body in a small page for the sandboxed frame. Links open in a new tab. */
export function renderBody({ html, text }) {
  const content = html ?? `<pre style="white-space:pre-wrap;font:inherit;margin:0">${escapeHtml(text ?? '')}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;background:#fff;color:#111}body{padding:14px;font:15px/1.5 system-ui,-apple-system,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%!important}</style>
</head><body>${content}</body></html>`;
}

/**
 * Mail: connected Gmail and Outlook accounts, a synced copy of their recent inbox, and actions on single mails.
 * `providers` can be swapped in tests. Mail is switched off (`enabled` false) until MAIL_TOKEN_KEY is set, and
 * each provider until its client ID and secret are set.
 */
export function createMail(db, { config, now = () => new Date(), providers } = {}) {
  const key = loadKey(config.mail?.tokenKey);
  const box = key ? createTokenBox(key) : null;
  providers ??= {
    google: createGmail(config.mail?.google ?? {}),
    microsoft: createGraph(config.mail?.microsoft ?? {}),
  };
  const oauth = createOAuth({ providers, publicUrl: config.mail?.publicUrl ?? `http://localhost:${config.port}` });
  // Access tokens last about an hour; they're kept in memory only and refreshed when needed.
  const accessTokens = new Map();
  let syncing = false;
  // Syncs running right now, by account id.
  const running = new Map();
  // First syncs started by a new connection run in the background; tests wait for them with settled().
  const background = new Set();

  const q = {
    accounts: db.prepare('SELECT * FROM mail_accounts WHERE user_id = ? ORDER BY id'),
    account: db.prepare('SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?'),
    accountById: db.prepare('SELECT * FROM mail_accounts WHERE id = ?'),
    due: db.prepare(`SELECT * FROM mail_accounts WHERE status = 'ok' AND (last_synced_at IS NULL OR last_synced_at <= ?) ORDER BY last_synced_at`),
    find: db.prepare('SELECT * FROM mail_accounts WHERE user_id = ? AND provider = ? AND email = ? COLLATE NOCASE'),
    colors: db.prepare('SELECT color FROM mail_accounts WHERE user_id = ?'),
    insertAccount: db.prepare('INSERT INTO mail_accounts (user_id, provider, email, color, refresh_token, scopes) VALUES (?, ?, ?, ?, ?, ?)'),
    reconnect: db.prepare(`UPDATE mail_accounts SET refresh_token = ?, scopes = ?, status = 'ok', last_error = NULL WHERE id = ?`),
    setToken: db.prepare('UPDATE mail_accounts SET refresh_token = ? WHERE id = ?'),
    synced: db.prepare(`UPDATE mail_accounts SET sync_cursor = ?, last_synced_at = ?, status = 'ok', last_error = NULL WHERE id = ?`),
    failed: db.prepare('UPDATE mail_accounts SET last_error = ?, last_synced_at = ? WHERE id = ?'),
    needsReconnect: db.prepare(`UPDATE mail_accounts SET status = 'needs_reconnect', last_error = ? WHERE id = ?`),
    removeAccount: db.prepare('DELETE FROM mail_accounts WHERE id = ?'),
    counts: db.prepare(`
      SELECT a.id, coalesce(sum(m.unread), 0) AS unread, coalesce(sum(m.starred), 0) AS starred
      FROM mail_accounts a LEFT JOIN mail_messages m ON m.account_id = a.id
      WHERE a.user_id = ? GROUP BY a.id`),

    upsert: db.prepare(`
      INSERT INTO mail_messages (account_id, provider_id, thread_id, from_name, from_address, subject, snippet, received_at, unread, starred, web_link)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (account_id, provider_id) DO UPDATE SET
        thread_id = excluded.thread_id, from_name = excluded.from_name, from_address = excluded.from_address,
        subject = excluded.subject, snippet = excluded.snippet, received_at = excluded.received_at,
        unread = excluded.unread, starred = excluded.starred, web_link = excluded.web_link`),
    removeMessage: db.prepare('DELETE FROM mail_messages WHERE account_id = ? AND provider_id = ?'),
    // After a full sync: drop what the provider no longer has in the inbox (starred mail stays).
    sweep: db.prepare(`
      DELETE FROM mail_messages WHERE account_id = ? AND starred = 0
        AND provider_id NOT IN (SELECT value FROM json_each(?))`),
    // Keep the last 30 days, at most 500 per account; starred mail is kept regardless.
    cleanup: db.prepare(`
      DELETE FROM mail_messages WHERE account_id = :account AND starred = 0 AND (
        received_at < :cutoff OR id NOT IN (
          SELECT id FROM mail_messages WHERE account_id = :account ORDER BY received_at DESC LIMIT :keep))`),
    message: db.prepare(`
      SELECT m.*, a.provider, a.email, a.color FROM mail_messages m JOIN mail_accounts a ON a.id = m.account_id
      WHERE m.id = ? AND a.user_id = ?`),
    list: db.prepare(`
      SELECT m.*, a.provider, a.email, a.color FROM mail_messages m JOIN mail_accounts a ON a.id = m.account_id
      WHERE a.user_id = :user
        AND (:account IS NULL OR a.id = :account)
        AND (:starred = 0 OR m.starred = 1)
        AND (:before IS NULL OR m.received_at < :before)
      ORDER BY m.received_at DESC, m.id DESC
      LIMIT :limit`),
    setStarred: db.prepare('UPDATE mail_messages SET starred = ? WHERE id = ?'),
    starredCount: db.prepare(`
      SELECT count(*) AS n FROM mail_messages m JOIN mail_accounts a ON a.id = m.account_id
      WHERE a.user_id = ? AND m.starred = 1`),
  };

  const enabled = box !== null;
  const iso = () => now().toISOString();
  const providerOf = (account) => providers[account.provider];

  function ensureProvider(name) {
    if (!enabled) throw new HttpError(503, 'Mail is not set up on the server yet (MAIL_TOKEN_KEY is missing)');
    const provider = providers[name];
    if (!provider) throw notFound('No such mail provider');
    if (!provider.enabled) throw new HttpError(503, `${provider.label} is not set up on the server yet (client ID and secret are missing)`);
    return provider;
  }

  function owned(userId, accountId) {
    const account = q.account.get(accountId, userId);
    if (!account) throw notFound('No such mail account');
    return account;
  }

  function ownedMessage(userId, messageId) {
    const m = q.message.get(messageId, userId);
    if (!m) throw notFound('No such mail');
    return m;
  }

  /** A working access token for the account, refreshing it when it's about to run out. */
  async function accessToken(account, { fresh = false } = {}) {
    const cached = accessTokens.get(account.id);
    if (!fresh && cached && cached.expires > Date.now() + 60_000) return cached.token;

    let refreshToken;
    try {
      refreshToken = box.open(account.refresh_token);
    } catch {
      q.needsReconnect.run('The saved sign-in could not be read (MAIL_TOKEN_KEY changed)', account.id);
      throw new NeedsReconnect();
    }
    let result;
    try {
      result = await providerOf(account).refresh(refreshToken);
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'invalid_grant') {
        accessTokens.delete(account.id);
        q.needsReconnect.run('Access was removed or has expired; connect the account again', account.id);
        throw new NeedsReconnect();
      }
      throw err;
    }
    // Microsoft hands out a new refresh token on every refresh; keep the newest.
    if (result.refreshToken && result.refreshToken !== refreshToken) q.setToken.run(box.seal(result.refreshToken), account.id);
    accessTokens.set(account.id, { token: result.accessToken, expires: Date.now() + (result.expiresIn ?? 3600) * 1000 });
    return result.accessToken;
  }

  /** Calls the provider with a token; on a 401, refreshes the token once and tries again. */
  async function withToken(account, fn) {
    try {
      return await fn(await accessToken(account));
    } catch (err) {
      if (err instanceof ProviderError && err.status === 401) return fn(await accessToken(account, { fresh: true }));
      throw err;
    }
  }

  function save(account, { upserts, removes, cursor, full }) {
    transaction(db, () => {
      for (const m of upserts) {
        q.upsert.run(account.id, m.providerId, m.threadId, m.fromName, m.fromAddress, m.subject, m.snippet, m.receivedAt, Number(m.unread), Number(m.starred), m.webLink);
      }
      for (const id of removes) q.removeMessage.run(account.id, id);
      if (full) q.sweep.run(account.id, JSON.stringify(upserts.map((m) => m.providerId)));
      const cutoff = new Date(now().getTime() - SYNC_DAYS * 86_400_000).toISOString();
      q.cleanup.run({ account: account.id, cutoff, keep: KEEP_PER_ACCOUNT });
      q.synced.run(cursor, iso(), account.id);
    });
  }

  /**
   * Brings one account up to date: only the changes when it can, a full sync the first time or when it must.
   * One sync per account at a time: a second call while one runs (the timer and "Sync now", say) waits for it.
   */
  function syncAccount(account) {
    if (running.has(account.id)) return running.get(account.id);
    const sync = runSync(q.accountById.get(account.id) ?? account).finally(() => running.delete(account.id));
    running.set(account.id, sync);
    return sync;
  }

  async function runSync(account) {
    const provider = providerOf(account);
    const ctx = { email: account.email, sinceDays: SYNC_DAYS, limit: KEEP_PER_ACCOUNT };
    try {
      let result = null;
      if (account.sync_cursor) {
        try {
          result = await withToken(account, (t) => provider.changes(t, account.sync_cursor, ctx));
        } catch (err) {
          if (!(err instanceof CursorExpired)) throw err;
        }
      }
      if (!result) {
        const first = await withToken(account, (t) => provider.initialSync(t, ctx));
        result = { upserts: first.messages, removes: [], cursor: first.cursor, full: true };
      }
      save(account, result);
      return { ok: true };
    } catch (err) {
      if (err instanceof NeedsReconnect) return { ok: false, needsReconnect: true };
      // Never log tokens or mail: the account id and the provider's error code are enough to look into it.
      console.error(`Mail sync failed for account ${account.id}: ${err.status ?? ''} ${err.code ?? err.name}`);
      const message = isRateLimited(err)
        ? `${provider.label} asked the app to slow down. It tries again by itself in a few minutes.`
        : String(err.message).slice(0, 300);
      q.failed.run(message, iso(), account.id);
      return { ok: false, error: message };
    }
  }

  function accountsOf(userId) {
    const counts = Object.fromEntries(q.counts.all(userId).map((c) => [c.id, c]));
    return q.accounts.all(userId).map((a) => accountJson(a, providers[a.provider]?.label, counts[a.id]));
  }

  return {
    enabled,
    providers,

    status: () => ({
      enabled,
      providers: Object.fromEntries(Object.entries(providers).map(([name, p]) => [name, { label: p.label, enabled: enabled && p.enabled }])),
    }),

    /** The provider sign-in URL to send the browser to. */
    connectUrl(userId, providerName) {
      ensureProvider(providerName);
      return oauth.start(userId, providerName);
    },

    /** Handles the provider's redirect back: stores (or reconnects) the account and starts its first sync. */
    async finishConnect(userId, providerName, { code, state, error }) {
      const provider = ensureProvider(providerName);
      if (error) throw badRequest(error === 'access_denied' ? 'Sign-in was cancelled' : `${provider.label} said: ${error}`);
      const tokens = await oauth.finish(userId, providerName, { code, state });
      const { email } = await provider.profile(tokens.accessToken);
      if (!email) throw badRequest(`${provider.label} did not say which address this is`);

      const sealed = box.seal(tokens.refreshToken);
      let account = q.find.get(userId, providerName, email);
      if (account) {
        q.reconnect.run(sealed, tokens.scope, account.id);
      } else {
        const used = new Set(q.colors.all(userId).map((r) => r.color));
        const color = [...Array(COLORS).keys()].map((i) => i + 1).find((c) => !used.has(c)) ?? (used.size % COLORS) + 1;
        const { lastInsertRowid } = q.insertAccount.run(userId, providerName, email, color, sealed, tokens.scope);
        account = { id: Number(lastInsertRowid) };
      }
      account = q.accountById.get(account.id);
      accessTokens.set(account.id, { token: tokens.accessToken, expires: Date.now() + (tokens.expiresIn ?? 3600) * 1000 });
      // The first sync can take a little while; the page shows the account straight away and the mail as it arrives.
      const first = syncAccount(account).finally(() => background.delete(first));
      background.add(first);
      return accountJson(account, provider.label);
    },

    accounts: accountsOf,

    /** Disconnect: ask the provider to revoke access (Google), then delete the account and its synced mail. */
    async disconnect(userId, accountId) {
      const account = owned(userId, accountId);
      try {
        await providerOf(account).revoke(box.open(account.refresh_token));
      } catch (err) {
        console.error(`Mail revoke failed for account ${account.id}: ${err.status ?? ''} ${err.code ?? err.name}`);
      }
      accessTokens.delete(account.id);
      q.removeAccount.run(account.id);
    },

    syncAccount,

    /** Resolves once background first syncs have finished. */
    settled: () => Promise.all([...background]),

    /** "Sync now" for one user's accounts (skips ones synced in the last 20 seconds). */
    async syncUser(userId) {
      const recent = new Date(now().getTime() - 20_000).toISOString();
      for (const account of q.accounts.all(userId)) {
        if (account.status !== 'ok' || (account.last_synced_at && account.last_synced_at > recent)) continue;
        await syncAccount(account);
      }
      return accountsOf(userId);
    },

    /** Called every minute by the job timer: syncs accounts whose last sync is 5 minutes old or more. */
    async runDue() {
      if (!enabled || syncing) return;
      syncing = true;
      try {
        const cutoff = new Date(now().getTime() - SYNC_EVERY_MS).toISOString();
        for (const account of q.due.all(cutoff)) {
          if (providers[account.provider]?.enabled) await syncAccount(account);
        }
      } finally {
        syncing = false;
      }
    },

    /** view: 'inbox' or 'starred'; before: receivedAt of the last mail shown, for the next page. */
    list(userId, { accountId = null, view = 'inbox', before = null, limit = LIST_LIMIT }) {
      const rows = q.list.all({ user: userId, account: accountId, starred: view === 'starred' ? 1 : 0, before, limit: limit + 1 });
      return { messages: rows.slice(0, limit).map(messageJson), hasMore: rows.length > limit };
    },

    message: (userId, messageId) => messageJson(ownedMessage(userId, messageId)),

    /** The mail's body, fetched live from the provider (never stored), as a page for the sandboxed frame. */
    async body(userId, messageId) {
      const m = ownedMessage(userId, messageId);
      const account = q.accountById.get(m.account_id);
      if (account.status !== 'ok') throw new HttpError(409, `Connect ${account.email} again to read its mail`);
      try {
        return renderBody(await withToken(account, (t) => providerOf(account).getBody(t, m.provider_id)));
      } catch (err) {
        if (err instanceof NeedsReconnect) throw new HttpError(409, `Connect ${account.email} again to read its mail`);
        if (err instanceof ProviderError && err.status === 404) throw notFound('This mail is no longer in the mailbox');
        throw err;
      }
    },

    /** Stars (Gmail) or flags (Outlook) a mail, at the provider first so the two never disagree. */
    async star(userId, messageId, starred) {
      const m = ownedMessage(userId, messageId);
      const account = q.accountById.get(m.account_id);
      if (account.status !== 'ok') throw new HttpError(409, `Connect ${account.email} again first`);
      try {
        await withToken(account, (t) => providerOf(account).setStarred(t, m.provider_id, starred));
      } catch (err) {
        if (err instanceof NeedsReconnect) throw new HttpError(409, `Connect ${account.email} again first`);
        if (err instanceof ProviderError && err.status === 403) {
          throw new HttpError(409, `${providerOf(account).label} didn't allow it. Connect ${account.email} again to allow starring.`);
        }
        throw err;
      }
      q.setStarred.run(Number(starred), m.id);
      return messageJson(ownedMessage(userId, messageId));
    },

    /** For the morning notification. */
    starredCount: (userId) => (enabled ? q.starredCount.get(userId).n : 0),

    /** For making a task: what to link to. */
    taskLink(userId, messageId) {
      const m = ownedMessage(userId, messageId);
      return { messageId: m.id, link: m.web_link, subject: m.subject };
    },
  };
}
