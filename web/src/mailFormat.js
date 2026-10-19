import { todayIST } from './dates.js';

// Times on mail, in IST like the rest of the app.

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const shortFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
const longFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "09:42" today, "Yesterday", "12 Oct" this year, "12 Oct 2025" before. */
export function mailTime(iso) {
  const date = new Date(iso);
  const day = dayFormat.format(date);
  const today = todayIST();
  if (day === today) return timeFormat.format(date);
  const yesterday = dayFormat.format(new Date(Date.parse(`${today}T12:00:00+05:30`) - 86_400_000));
  if (day === yesterday) return 'Yesterday';
  return day.slice(0, 4) === today.slice(0, 4) ? shortFormat.format(date) : `${shortFormat.format(date)} ${day.slice(0, 4)}`;
}

/** "Fri, 16 Oct 2026, 09:42" */
export const mailDateTime = (iso) => longFormat.format(new Date(iso));

/** "just now", "4 min ago", "2 h ago", or a date. */
export function ago(iso) {
  if (!iso) return 'not yet';
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return mailTime(iso);
}

export const accountColor = (color) => `var(--mail-${color})`;

export const providerApp = (provider) => (provider === 'google' ? 'Gmail' : 'Outlook');
