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

const timeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: config.timeZone,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** 'HH:MM' (24-hour) for the given moment, in the app's time zone. */
export const timeOf = (date = new Date()) => timeFormat.format(date);

/** Whole days from `a` to `b` ('YYYY-MM-DD'); negative if b is earlier. */
export const daysBetween = (a, b) => Math.round((asDate(b) - asDate(a)) / 86_400_000);

/** Number of days in a month (month 1–12). */
export const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** 'HH:MM' → minutes since midnight, and back. */
export const minutesOf = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
export const timeFromMinutes = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** 'HH:MM' (24-hour, as stored) → "9:27 PM", for messages people read. */
export function formatTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
