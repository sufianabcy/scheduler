import { createHash, randomBytes } from 'node:crypto';
import { badRequest } from '../http.js';

const TEN_MINUTES = 10 * 60 * 1000;

/**
 * The sign-in flow for connecting a mailbox (OAuth authorization code + PKCE).
 * start(): makes a one-time `state` and a PKCE verifier, remembers them for 10 minutes, and returns the provider's
 * sign-in URL. finish(): checks the state came back to the same user and provider, then swaps the code for tokens.
 * So nobody can attach their own mailbox to your login or replay a code. Pending sign-ins live in memory: the server
 * is one process, and a restart in the middle of a sign-in just means trying again.
 */
export function createOAuth({ providers, publicUrl, now = () => Date.now() }) {
  const pending = new Map();

  const redirectUri = (provider) => `${publicUrl}/api/mail/callback/${provider}`;

  const prune = () => {
    const t = now();
    for (const [state, p] of pending) if (p.expires <= t) pending.delete(state);
  };

  return {
    redirectUri,

    start(userId, providerName) {
      prune();
      const provider = providers[providerName];
      const state = randomBytes(24).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      pending.set(state, { userId, provider: providerName, verifier, expires: now() + TEN_MINUTES });
      return provider.authorizeUrl({ redirectUri: redirectUri(providerName), state, challenge });
    },

    /** Returns the provider's tokens: { refreshToken, accessToken, expiresIn, scope }. */
    async finish(userId, providerName, { code, state }) {
      prune();
      const p = pending.get(state);
      if (!p || p.userId !== userId || p.provider !== providerName) {
        throw badRequest('That sign-in link has expired or was not started here. Please connect again.');
      }
      pending.delete(state);
      if (!code) throw badRequest('The sign-in did not return a code');
      return providers[providerName].exchangeCode({ code, verifier: p.verifier, redirectUri: redirectUri(providerName) });
    },
  };
}
