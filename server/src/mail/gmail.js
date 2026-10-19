import { CursorExpired, ProviderError, decodeEntities, mapLimit, parseAddress, request } from './http.js';

// gmail.modify lets the app read mail and change labels (star/unstar). It can't send mail or delete it for good.
export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

const DEFAULT_ENDPOINTS = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  api: 'https://gmail.googleapis.com/gmail/v1/users/me',
};

/** Finds the HTML part of a message (or the plain-text one) and decodes it. */
async function extractBody(payload, fetchAttachment) {
  const parts = [];
  const walk = (part) => {
    if (!part) return;
    parts.push(part);
    (part.parts ?? []).forEach(walk);
  };
  walk(payload);
  const part = parts.find((p) => p.mimeType === 'text/html') ?? parts.find((p) => p.mimeType === 'text/plain');
  if (!part) return { text: '' };

  let data = part.body?.data;
  if (!data && part.body?.attachmentId) data = (await fetchAttachment(part.body.attachmentId)).data;
  const bytes = Buffer.from(data ?? '', 'base64url');
  const contentType = part.headers?.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
  const charset = /charset="?([\w-]+)"?/i.exec(contentType)?.[1] ?? 'utf-8';
  let content;
  try {
    content = new TextDecoder(charset).decode(bytes);
  } catch {
    content = new TextDecoder('utf-8').decode(bytes);
  }
  return part.mimeType === 'text/html' ? { html: content } : { text: content };
}

/** Gmail through the Gmail REST API. Same functions as graph.js, so the rest of the app doesn't care which it is. */
export function createGmail({ clientId, clientSecret, endpoints = {} }) {
  const e = { ...DEFAULT_ENDPOINTS, ...endpoints };

  function normalize(m, email) {
    const headers = Object.fromEntries((m.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
    const from = parseAddress(headers.from);
    const labels = m.labelIds ?? [];
    return {
      providerId: m.id,
      threadId: m.threadId ?? null,
      fromName: from.name,
      fromAddress: from.address,
      subject: headers.subject ?? '',
      snippet: decodeEntities(m.snippet ?? ''),
      receivedAt: new Date(Number(m.internalDate)).toISOString(),
      unread: labels.includes('UNREAD'),
      starred: labels.includes('STARRED'),
      inInbox: labels.includes('INBOX'),
      webLink: `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}#all/${m.id}`,
    };
  }

  /** Fetches the headers of each message. Ones no longer in the inbox (or gone) come back as removes. */
  async function fetchMany(token, ids, email) {
    const upserts = [];
    const removes = [];
    await mapLimit(ids, 4, async (id) => {
      try {
        const m = await request(`${e.api}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, { token });
        const n = normalize(m, email);
        if (n.inInbox) upserts.push(n);
        else removes.push(id);
      } catch (err) {
        if (err.status === 404) removes.push(id);
        else throw err;
      }
    });
    return { upserts, removes };
  }

  return {
    name: 'google',
    label: 'Gmail',
    enabled: Boolean(clientId && clientSecret),

    authorizeUrl({ redirectUri, state, challenge }) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GOOGLE_SCOPES.join(' '),
        // offline + consent: Google only hands out a refresh token when it asks for consent.
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      return `${e.authorize}?${params}`;
    },

    async exchangeCode({ code, verifier, redirectUri }) {
      const t = await request(e.token, {
        method: 'POST',
        form: { code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier },
      });
      if (!t.refresh_token) {
        throw new ProviderError('Google did not hand out a refresh token. Remove "Planner" at myaccount.google.com/permissions and connect again.');
      }
      return { refreshToken: t.refresh_token, accessToken: t.access_token, expiresIn: t.expires_in, scope: t.scope ?? GOOGLE_SCOPES.join(' ') };
    },

    async refresh(refreshToken) {
      const t = await request(e.token, {
        method: 'POST',
        form: { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' },
      });
      return { accessToken: t.access_token, expiresIn: t.expires_in, refreshToken: t.refresh_token ?? null };
    },

    async revoke(refreshToken) {
      await request(e.revoke, { method: 'POST', form: { token: refreshToken } });
    },

    async profile(token) {
      const p = await request(`${e.api}/profile`, { token });
      return { email: p.emailAddress };
    },

    /** Inbox mail from the last `sinceDays` days (at most `limit`), and the cursor to ask for changes from. */
    async initialSync(token, { email, sinceDays, limit }) {
      // The history position is read first, so anything that changes while we list is picked up next time.
      const profile = await request(`${e.api}/profile`, { token });
      const ids = [];
      let pageToken;
      do {
        const params = new URLSearchParams({ q: `in:inbox newer_than:${sinceDays}d`, maxResults: String(Math.min(100, limit - ids.length)) });
        if (pageToken) params.set('pageToken', pageToken);
        const page = await request(`${e.api}/messages?${params}`, { token });
        ids.push(...(page.messages ?? []).map((m) => m.id));
        pageToken = page.nextPageToken;
      } while (pageToken && ids.length < limit);
      const { upserts } = await fetchMany(token, ids, email);
      return { messages: upserts, cursor: String(profile.historyId) };
    },

    /** What changed since `cursor`: new and changed mail (re-read), removed mail, and the new cursor. */
    async changes(token, cursor, { email }) {
      const changed = new Set();
      const deleted = new Set();
      let historyId = cursor;
      let pageToken;
      do {
        const params = new URLSearchParams({ startHistoryId: cursor });
        for (const type of ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved']) params.append('historyTypes', type);
        if (pageToken) params.set('pageToken', pageToken);
        let page;
        try {
          page = await request(`${e.api}/history?${params}`, { token });
        } catch (err) {
          // Gmail keeps history for about a week; older cursors answer 404.
          if (err.status === 404) throw new CursorExpired();
          throw err;
        }
        for (const h of page.history ?? []) {
          for (const x of [...(h.messagesAdded ?? []), ...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])]) changed.add(x.message.id);
          for (const x of h.messagesDeleted ?? []) deleted.add(x.message.id);
        }
        historyId = page.historyId ?? historyId;
        pageToken = page.nextPageToken;
      } while (pageToken);

      for (const id of deleted) changed.delete(id);
      const { upserts, removes } = await fetchMany(token, [...changed], email);
      return { upserts, removes: [...removes, ...deleted], cursor: String(historyId) };
    },

    async getBody(token, providerId) {
      const m = await request(`${e.api}/messages/${providerId}?format=full`, { token });
      return extractBody(m.payload, (attachmentId) => request(`${e.api}/messages/${providerId}/attachments/${attachmentId}`, { token }));
    },

    async setStarred(token, providerId, starred) {
      await request(`${e.api}/messages/${providerId}/modify`, {
        method: 'POST',
        token,
        json: starred ? { addLabelIds: ['STARRED'] } : { removeLabelIds: ['STARRED'] },
      });
    },
  };
}
