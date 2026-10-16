import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/users.js';

export const testConfig = {
  host: '127.0.0.1',
  port: 0,
  dbPath: ':memory:',
  cookieSecure: false,
  trustProxy: false,
  timeZone: 'Asia/Kolkata',
  sessionDays: 30,
};

export const randomPassword = () => randomBytes(12).toString('base64url');

/** Starts the app on a random port with an in-memory database. Call close() when done. */
export async function startTestServer() {
  const db = openDb(':memory:');
  const app = createApp({ db, config: testConfig });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    db,
    baseUrl,
    addUser: (email, password) => createUser(db, email, password),
    /** fetch() against the app; `cookie` is sent as-is, JSON bodies are encoded. */
    request(path, { method = 'GET', body, cookie, headers = {} } = {}) {
      return fetch(baseUrl + path, {
        method,
        headers: {
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
          ...(cookie && { Cookie: cookie }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}

/** Returns "name=value" from a response's Set-Cookie header. */
export const cookieFrom = (res) => res.headers.get('set-cookie')?.split(';')[0];

/**
 * Creates a user, logs in, and returns api(method, path, body) → { status, body } for that user.
 * Writes without a body send {} so they pass the JSON-only check.
 */
export async function loggedIn(t, email) {
  const password = randomPassword();
  await t.addUser(email, password);
  const login = await t.request('/api/auth/login', { method: 'POST', body: { email, password } });
  const cookie = cookieFrom(login);
  return async (method, path, body) => {
    const res = await t.request(path, { method, cookie, body: method === 'GET' ? undefined : (body ?? {}) });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
}
