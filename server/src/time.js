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
