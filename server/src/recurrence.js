import { addDays, daysBetween, daysInMonth, weekStart, weekdayIndex } from './time.js';

// When a repeating task happens. A rule is a repeating_tasks row:
//   freq 'daily' | 'weekly' | 'monthly', every N (1–99), weekdays bitmask (weekly only; Mon = 1 … Sun = 64),
//   start_day, end_day (or null).
// Weekly counts whole Monday-to-Sunday weeks from the start day's week; monthly repeats on the start day's
// date, or the month's last day when the month is shorter (31 Jan → 28 Feb).

export function occursOn(rule, day) {
  const start = rule.start_day ?? day;
  if (day < start) return false;
  if (rule.end_day && day > rule.end_day) return false;
  switch (rule.freq) {
    case 'daily':
      return daysBetween(start, day) % rule.every === 0;
    case 'weekly': {
      if ((rule.weekdays & (1 << weekdayIndex(day))) === 0) return false;
      const weeks = daysBetween(weekStart(start), weekStart(day)) / 7;
      return weeks % rule.every === 0;
    }
    case 'monthly': {
      const [sy, sm, sd] = start.split('-').map(Number);
      const [y, m, d] = day.split('-').map(Number);
      const months = (y - sy) * 12 + (m - sm);
      return months % rule.every === 0 && d === Math.min(sd, daysInMonth(y, m));
    }
    default:
      return false;
  }
}

/** The first day on or after `from` that the rule happens, or null if none within ~2 years. */
export function nextOccurrence(rule, from) {
  for (let i = 0, day = from; i < 800; i++, day = addDays(day, 1)) {
    if (rule.end_day && day > rule.end_day) return null;
    if (occursOn(rule, day)) return day;
  }
  return null;
}
