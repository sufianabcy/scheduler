// Small wrapper around fetch for the server's JSON API.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let onLoggedOut = () => {};
/** Called whenever the server says the session is gone, so the app can show the login screen. */
export const setLoggedOutHandler = (fn) => {
  onLoggedOut = fn;
};

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      // Writes always send JSON (the server refuses anything else), even with no body.
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new ApiError(0, navigator.onLine ? "Can't reach the server" : "You're offline. Changes need internet.");
  }

  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') onLoggedOut();
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  }
  return data;
}

export const get = (path) => api('GET', path);
export const post = (path, body) => api('POST', path, body);
export const patch = (path, body) => api('PATCH', path, body);
export const put = (path, body) => api('PUT', path, body);
export const del = (path) => api('DELETE', path);
