import { dayLabel } from './dates.js';

// Repeat options and their wording, Google Tasks style. A repeat is
// { freq: 'daily' | 'weekly' | 'monthly', every: N, weekdays: ['mon', …] (weekly), until: 'YYYY-MM-DD' | null }.

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const SHORT = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const LONG = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const WORKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];

/** 'mon' … 'sun' for a 'YYYY-MM-DD' day. */
export const weekdayOf = (day) => WEEKDAYS[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7];
const dateOf = (day) => Number(day.slice(8));
const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/** The quick choices for a task on `day`, then "Custom…". */
export function presets(day) {
  const wd = weekdayOf(day);
  return [
    { key: 'none', label: 'Does not repeat', value: null },
    { key: 'daily', label: 'Daily', value: { freq: 'daily', every: 1, weekdays: [], until: null } },
    { key: 'workdays', label: 'Every weekday (Mon–Fri)', value: { freq: 'weekly', every: 1, weekdays: WORKDAYS, until: null } },
    { key: 'weekly', label: `Weekly on ${LONG[wd]}`, value: { freq: 'weekly', every: 1, weekdays: [wd], until: null } },
    { key: 'monthly', label: `Monthly on day ${dateOf(day)}`, value: { freq: 'monthly', every: 1, weekdays: [], until: null } },
    { key: 'custom', label: 'Custom…', value: undefined },
  ];
}

/** Which preset a repeat matches, or 'custom'. */
export function presetKey(repeat, day) {
  if (!repeat) return 'none';
  const match = presets(day).find(
    (p) =>
      p.value &&
      p.value.freq === repeat.freq &&
      p.value.every === repeat.every &&
      !repeat.until &&
      (repeat.freq !== 'weekly' || same(p.value.weekdays, repeat.weekdays)) &&
      (repeat.freq !== 'monthly' || !repeat.startDay || dateOf(repeat.startDay) === dateOf(day)),
  );
  return match?.key ?? 'custom';
}

/** e.g. "Every weekday", "Every 2 weeks on Mon, Thu", "Monthly on day 18 until 31 Dec". */
export function describeRepeat(repeat, day) {
  if (!repeat) return 'Does not repeat';
  const n = repeat.every ?? 1;
  let text;
  if (repeat.freq === 'daily') {
    text = n === 1 ? 'Daily' : `Every ${n} days`;
  } else if (repeat.freq === 'weekly') {
    const days = repeat.weekdays?.length ? repeat.weekdays : [weekdayOf(repeat.startDay ?? day)];
    const list = same(days, WORKDAYS) ? 'weekdays' : days.length === 7 ? 'every day' : WEEKDAYS.filter((d) => days.includes(d)).map((d) => SHORT[d]).join(', ');
    if (n === 1) text = list === 'weekdays' ? 'Every weekday' : list === 'every day' ? 'Daily' : `Weekly on ${list}`;
    else text = `Every ${n} weeks on ${list}`;
  } else {
    const d = dateOf(repeat.startDay ?? day);
    text = n === 1 ? `Monthly on day ${d}` : `Every ${n} months on day ${d}`;
  }
  if (repeat.until) text += ` until ${dayLabel(repeat.until)}`;
  return text;
}

/** Repeat as the server wants it (drops display-only fields). */
export const repeatBody = (r) => (r ? { freq: r.freq, every: r.every ?? 1, weekdays: r.freq === 'weekly' ? r.weekdays ?? [] : [], until: r.until ?? null } : null);

export const sameRepeat = (a, b) => JSON.stringify(repeatBody(a)) === JSON.stringify(repeatBody(b));
