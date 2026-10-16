// Dates in the app are IST calendar days ('YYYY-MM-DD'), the same as on the server.

const TIME_ZONE = 'Asia/Kolkata';
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const hourFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', hourCycle: 'h23' });

export const todayIST = () => dayFormat.format(new Date());
export const hourIST = () => Number(hourFormat.format(new Date()));

const asDate = (day) => new Date(`${day}T00:00:00Z`);

export function addDays(day, n) {
  const d = asDate(day);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function addMonths(month, n) {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
}

/** "Today", "Tomorrow", "Yesterday", or e.g. "Mon 19 Oct". */
export function dayLabel(day, today = todayIST()) {
  if (day === today) return 'Today';
  if (day === addDays(today, 1)) return 'Tomorrow';
  if (day === addDays(today, -1)) return 'Yesterday';
  return asDate(day).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** e.g. "Friday, 16 October". */
export const longDay = (day) =>
  asDate(day).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

/** e.g. "October 2026". */
export const monthLabel = (month) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
