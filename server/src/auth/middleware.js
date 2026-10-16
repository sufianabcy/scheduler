export const SESSION_COOKIE = 'sp_session';

export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export function sessionCookieOptions({ cookieSecure }, maxAgeMs) {
  return {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'lax',
    path: '/',
    ...(maxAgeMs !== undefined && { maxAge: maxAgeMs }),
  };
}

/** Sets req.user when the request carries a valid session cookie. Never rejects on its own. */
export function loadSession(sessions, config) {
  return (req, res, next) => {
    const token = readCookie(req, SESSION_COOKIE);
    const found = sessions.lookup(token);
    if (found) {
      req.user = found.user;
      req.sessionToken = token;
      if (found.renewed) {
        res.cookie(SESSION_COOKIE, token, sessionCookieOptions(config, sessions.lifetimeMs));
      }
    }
    next();
  };
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

/**
 * Changing requests must send JSON. Browsers can't send a cross-site JSON request without a CORS preflight,
 * which this server never approves, so together with the SameSite=Lax cookie this blocks CSRF.
 */
export function requireJsonForWrites(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Checks the header itself, not req.is(), so a write with an empty body (e.g. logout) is judged the same way.
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    return res.status(415).json({ error: 'Send requests as application/json' });
  }
  next();
}
