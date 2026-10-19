// Small fetch helpers for the Google and Microsoft APIs (Node's built-in fetch; no SDKs).

/** An error from a provider: `status` is the HTTP status, `code` the provider's error code when it gave one. */
export class ProviderError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'RESOURCE_EXHAUSTED']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when the provider said "too many requests, slow down" (Gmail: 429, or 403 with a rate-limit reason). */
export const isRateLimited = (err) => err instanceof ProviderError && (err.status === 429 || RATE_REASONS.has(err.code));

/**
 * Calls a JSON API. `form` sends application/x-www-form-urlencoded (OAuth token endpoints), `json` a JSON body.
 * Returns the parsed body (or null for an empty one); throws ProviderError for any non-2xx answer.
 * When the provider says to slow down, it waits (Retry-After, or 2, 4, 8 seconds) and tries again, up to `retries` times.
 */
export async function request(url, { method = 'GET', token, headers = {}, form, json, timeoutMs = 20_000, retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestOnce(url, { method, token, headers, form, json, timeoutMs });
    } catch (err) {
      if (!isRateLimited(err) || attempt >= retries) throw err;
      await sleep(err.retryAfterMs ?? 2000 * 2 ** attempt);
    }
  }
}

async function requestOnce(url, { method, token, headers, form, json, timeoutMs }) {
  const init = { method, headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (form) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(form).toString();
  } else if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new ProviderError(`Network error: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    // OAuth errors: { error: 'invalid_grant', error_description }; Google API errors: { error: { code, message, status,
    // errors: [{ reason }] } }; Graph: { error: { code, message } }. A rate-limit reason wins, so it can be spotted.
    const reason = body?.error?.errors?.[0]?.reason;
    const code =
      typeof body?.error === 'string'
        ? body.error
        : RATE_REASONS.has(reason)
          ? reason
          : (body?.error?.status ?? body?.error?.code ?? null);
    const detail = body?.error_description ?? body?.error?.message ?? `HTTP ${res.status}`;
    const err = new ProviderError(String(detail).slice(0, 300), { status: res.status, code });
    const retryAfter = Number(res.headers.get('retry-after'));
    if (res.headers.has('retry-after') && Number.isFinite(retryAfter)) err.retryAfterMs = Math.min(retryAfter, 60) * 1000;
    throw err;
  }
  return body;
}

/** Runs `fn` over `items` with at most `limit` at a time; keeps the order of results. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Splits a From header like `"Ravi K" <ravi@example.com>` into a name and an address. */
export function parseAddress(value = '') {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  if (match) return { name: match[1].trim() || null, address: match[2].trim() };
  return { name: null, address: value.trim() || null };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Gmail snippets come HTML-escaped; turns them back into plain text. */
export function decodeEntities(text = '') {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** The saved sync position is too old for the provider; the account needs a fresh full sync. */
export class CursorExpired extends Error {}
