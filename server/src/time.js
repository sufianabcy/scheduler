import { config } from './config.js';

// The app works in one time zone (IST): "today" and "this month" mean the date on a clock in India.

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 'YYYY-MM-DD' for the given moment, in the app's time zone. */
export const dayOf = (date = new Date()) => dayFormat.format(date);

/** 'YYYY-MM' for the given moment, in the app's time zone. */
export const monthOf = (date = new Date()) => dayOf(date).slice(0, 7);

// Day arithmetic on 'YYYY-MM-DD' strings. They are plain calendar dates, so UTC math is safe here.
const asDate = (day) => new Date(`${day}T00:00:00Z`);

export function addDays(day, n) {
  const d = asDate(day);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday. */
export const weekdayIndex = (day) => (asDate(day).getUTCDay() + 6) % 7;

/** The Monday of the week that `day` is in. */
export const weekStart = (day) => addDays(day, -weekdayIndex(day));
