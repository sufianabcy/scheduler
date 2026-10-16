import { badRequest, notFound } from './http.js';

// Request body checks. Each returns the cleaned value or throws a 400.

const MAX_TITLE = 200;
const MAX_LIST = 100;

export function title(value, field = 'title') {
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`${field} is required`);
  const trimmed = value.trim();
  if (trimmed.length > MAX_TITLE) throw badRequest(`${field} must be at most ${MAX_TITLE} characters`);
  return trimmed;
}

/** A real calendar date as 'YYYY-MM-DD'. */
export function day(value, field = 'day') {
  const valid =
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
  if (!valid) throw badRequest(`${field} must be a date like 2026-10-16`);
  return value;
}

/** A month as 'YYYY-MM'. */
export function month(value, field = 'month') {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw badRequest(`${field} must be a month like 2026-10`);
  }
  return value;
}

/** An id from the URL. Anything that isn't a positive whole number can't exist, so it's a 404. */
export function pathId(value) {
  if (!/^[1-9]\d{0,15}$/.test(String(value))) throw notFound();
  return Number(value);
}

/** An optional id in the body: undefined/null stay null. */
export function optionalId(value, field) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 1) throw badRequest(`${field} must be an id`);
  return value;
}

export function idList(value, field) {
  if (!Array.isArray(value) || !value.every((v) => Number.isInteger(v) && v > 0)) {
    throw badRequest(`${field} must be a list of ids`);
  }
  if (new Set(value).size !== value.length) throw badRequest(`${field} has the same id twice`);
  return value;
}

/** An optional list of up to 100 entries, each cleaned by `each(entry, label)`. */
export function list(value, field, each) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest(`${field} must be a list`);
  if (value.length > MAX_LIST) throw badRequest(`${field} can have at most ${MAX_LIST} entries`);
  return value.map((entry, i) => each(entry, `${field}[${i}]`));
}

export function boolean(value, field) {
  if (typeof value !== 'boolean') throw badRequest(`${field} must be true or false`);
  return value;
}
