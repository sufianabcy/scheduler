import { CursorExpired, request } from './http.js';

// Outlook.com, Hotmail and Microsoft 365 through Microsoft Graph. Mail.ReadWrite is needed to flag mail;
// no send permission is asked for.
export const MICROSOFT_SCOPES = ['offline_access', 'User.Read', 'Mail.ReadWrite'];

const DEFAULT_ENDPOINTS = {
  authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  api: 'https://graph.microsoft.com/v1.0',
};

const SELECT = 'subject,from,receivedDateTime,isRead,flag,bodyPreview,webLink,conversationId';

function normalize(m) {
  return {
    providerId: m.id,
    threadId: m.conversationId ?? null,
    fromName: m.from?.emailAddress?.name ?? null,
    fromAddress: m.from?.emailAddress?.address ?? null,
    subject: m.subject ?? '',
    snippet: m.bodyPreview ?? '',
    receivedAt: new Date(m.receivedDateTime).toISOString(),
    unread: m.isRead === false,
    starred: m.flag?.flagStatus === 'flagged',
    webLink: m.webLink ?? null,
  };
}

/** Microsoft Graph. Same functions as gmail.js. */
export function createGraph({ clientId, clientSecret, endpoints = {} }) {
  const e = { ...DEFAULT_ENDPOINTS, ...endpoints };

  /** Follows a delta query to its end: what was added or changed, what was removed, and the next delta link. */
  async function walkDelta(token, url) {
    const upserts = [];
    const removes = [];
    let next = url;
    for (let pages = 0; pages < 200; pages++) {
      let page;
      try {
        page = await request(next, { token, headers: { Prefer: 'odata.maxpagesize=50' } });
      } catch (err) {
        if (err.status === 410) throw new CursorExpired();
        throw err;
      }
      for (const item of page.value ?? []) {
        if (item['@removed']) removes.push(item.id);
        else upserts.push(normalize(item));
      }
      if (page['@odata.deltaLink']) return { upserts, removes, cursor: page['@odata.deltaLink'] };
      next = page['@odata.nextLink'];
      if (!next) break;
    }
    throw new Error('Outlook sync did not finish');
  }

  return {
    name: 'microsoft',
    label: 'Outlook',
    enabled: Boolean(clientId && clientSecret),

    authorizeUrl({ redirectUri, state, challenge }) {
      const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        response_mode: 'query',
        scope: MICROSOFT_SCOPES.join(' '),
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      return `${e.authorize}?${params}`;
    },

    async exchangeCode({ code, verifier, redirectUri }) {
      const t = await request(e.token, {
        method: 'POST',
        form: {
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: verifier,
          scope: MICROSOFT_SCOPES.join(' '),
        },
      });
      return { refreshToken: t.refresh_token, accessToken: t.access_token, expiresIn: t.expires_in, scope: t.scope ?? '' };
    },

    /** Microsoft hands out a new refresh token each time; the caller saves it. */
    async refresh(refreshToken) {
      const t = await request(e.token, {
        method: 'POST',
        form: { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token', scope: MICROSOFT_SCOPES.join(' ') },
      });
      return { accessToken: t.access_token, expiresIn: t.expires_in, refreshToken: t.refresh_token ?? null };
    },

    // Graph has no call to revoke one app's token; deleting it is what Disconnect can do. To also remove the app's
    // access at Microsoft, use account.live.com/consent/Manage (personal) or myapps.microsoft.com (work).
    async revoke() {},

    async profile(token) {
      const me = await request(`${e.api}/me?$select=mail,userPrincipalName`, { token });
      return { email: me.mail ?? me.userPrincipalName };
    },

    async initialSync(token, { sinceDays }) {
      const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
      const url = `${e.api}/me/mailFolders/inbox/messages/delta?$select=${SELECT}&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`;
      const { upserts, cursor } = await walkDelta(token, url);
      return { messages: upserts, cursor };
    },

    changes: (token, cursor) => walkDelta(token, cursor),

    async getBody(token, providerId) {
      const m = await request(`${e.api}/me/messages/${encodeURIComponent(providerId)}?$select=body`, {
        token,
        headers: { Prefer: 'outlook.body-content-type="html"' },
      });
      return m.body?.contentType === 'html' ? { html: m.body.content ?? '' } : { text: m.body?.content ?? '' };
    },

    async setStarred(token, providerId, starred) {
      await request(`${e.api}/me/messages/${encodeURIComponent(providerId)}`, {
        method: 'PATCH',
        token,
        json: { flag: { flagStatus: starred ? 'flagged' : 'notFlagged' } },
      });
    },
  };
}
