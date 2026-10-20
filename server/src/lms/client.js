// A small client for Moodle's web-service API (the one the Moodle mobile app uses). Node's built-in fetch; no SDK.
// The token and password only ever go in POST bodies, never in a URL, and never into an error message.

/** An error from the LMS. `code` is Moodle's errorcode (e.g. 'invalidtoken', 'invalidlogin') when it gave one. */
export class LmsError extends Error {
  constructor(message, { code = null, status = 0 } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Moodle says the token is no longer any good: expired, removed, or the password was changed. ('accessexception'
// only means that when site info itself is refused, which the sync checks separately; on any other call it means
// that one function or activity was refused, which shouldn't ask you to reconnect.)
export const isTokenError = (err) => err instanceof LmsError && err.code === 'invalidtoken';

/** Moodle's form encoding for nested parameters: { courseids: [3, 5] } → courseids[0]=3&courseids[1]=5. */
export function flatten(params, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(params)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') flatten(value, name, out);
    else out[name] = String(typeof value === 'boolean' ? Number(value) : value);
  }
  return out;
}

/** `baseUrl`: the Moodle site, e.g. https://lms.kluniversity.in. */
export function createLmsClient({ baseUrl, timeoutMs = 30_000 }) {
  async function post(path, form) {
    let res;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new LmsError(`Can't reach the LMS: ${err.name === 'TimeoutError' ? 'it took too long to answer' : 'network error'}`, { code: 'network' });
    }
    const text = await res.text();
    if (!res.ok) throw new LmsError(`The LMS answered HTTP ${res.status}`, { status: res.status, code: 'http' });
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      // A login page or maintenance page instead of JSON.
      throw new LmsError("The LMS didn't answer as expected (it may be under maintenance)", { status: res.status, code: 'notjson' });
    }
  }

  return {
    baseUrl,

    /** Swaps a username and password for a web-service token. The password is used for this one request only. */
    async getToken(username, password) {
      const body = await post('/login/token.php', { username, password, service: 'moodle_mobile_app' });
      if (body?.token) return body.token;
      throw new LmsError(body?.error ?? 'The LMS did not give a token', { code: body?.errorcode ?? 'notoken' });
    },

    /** Calls one web-service function. Moodle reports errors as 200s with { exception, errorcode, message }. */
    async call(token, wsfunction, params = {}) {
      const path = `/webservice/rest/server.php?moodlewsrestformat=json&wsfunction=${encodeURIComponent(wsfunction)}`;
      const body = await post(path, { wstoken: token, ...flatten(params) });
      if (body && typeof body === 'object' && !Array.isArray(body) && body.exception) {
        throw new LmsError(String(body.message ?? body.errorcode).slice(0, 300), { code: body.errorcode ?? body.exception });
      }
      return body;
    },
  };
}
