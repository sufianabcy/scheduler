// Quick add: reads a date, reminder time, repeat and priority out of one typed line, Todoist style.
//   "gym tomorrow 7am every mon wed p1" → title "gym", day tomorrow, reminder 07:00, weekly Mon+Wed, P1
// Small and dependency-free on purpose (a full date library would be ~100x the size of this app).
// Everything is relative to `today` (an IST 'YYYY-MM-DD'), and dates never land in the past.

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY = '(?:mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)';
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WORKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];

/** A whole-word pattern: only matches between spaces or punctuation, never inside a word. */
const word = (pattern) => new RegExp(`(?<=^|[\\s,(])${pattern}(?=$|[\\s,.!?)])`, 'i');

const weekdayIndexOf = (name) => WEEKDAYS.indexOf(name.slice(0, 3).toLowerCase());

const asDate = (day) => new Date(`${day}T00:00:00Z`);
const addDays = (day, n) => {
  const d = asDate(day);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekdayOf = (day) => (asDate(day).getUTCDay() + 6) % 7;
const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' if it's a real date, else null. */
function realDay(year, month, date) {
  const day = `${year}-${pad(month)}-${pad(date)}`;
  return asDate(day).toISOString().startsWith(day) ? day : null;
}

/** A date without a year: this year, or next year if it has already passed. */
function upcoming(today, month, date, year) {
  const thisYear = Number(today.slice(0, 4));
  if (year) return realDay(year < 100 ? 2000 + year : year, month, date);
  const day = realDay(thisYear, month, date);
  return day && day < today ? realDay(thisYear + 1, month, date) : day;
}

const time = (h, m) => (h >= 0 && h <= 23 && m >= 0 && m <= 59 ? `${pad(h)}:${pad(m)}` : null);

/**
 * Returns { title, day, remindAt, repeat, priority, found } where each value is null when not typed, and `found`
 * lists the pieces that were recognised (for showing what will happen before adding).
 */
export function parseQuickAdd(text, today) {
  let rest = text;
  const out = { day: null, remindAt: null, repeat: null, priority: null };
  const found = [];

  /** Finds `re`; if `fn` accepts the match, cuts it out of the text. */
  const take = (re, fn) => {
    const m = rest.match(re);
    if (!m || fn(m) === false) return false;
    rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
    return true;
  };

  // Priority: p1, p2, p3
  take(word('p([1-3])'), (m) => {
    out.priority = Number(m[1]);
    found.push('priority');
  });

  // Repeat (before weekdays and dates, so "every mon" isn't read as a single Monday)
  const setRepeat = (repeat) => {
    out.repeat = { every: 1, weekdays: [], until: null, ...repeat };
    found.push('repeat');
  };
  take(word('every\\s+(?:week\\s?day|work\\s?day)s?'), () => setRepeat({ freq: 'weekly', weekdays: WORKDAYS })) ||
    take(word('(?:every\\s?day|daily)'), () => setRepeat({ freq: 'daily' })) ||
    take(word('every\\s+other\\s+(day|week|month)'), (m) => setRepeat({ freq: unitFreq(m[1]), every: 2 })) ||
    take(word('every\\s+(\\d{1,2})\\s+(days?|weeks?|months?)'), (m) => {
      const every = Number(m[1]);
      if (every < 1 || every > 99) return false;
      setRepeat({ freq: unitFreq(m[2]), every });
    }) ||
    take(word(`every\\s+(${DAY}(?:\\s*(?:,|and|&)?\\s*${DAY})*)`), (m) => {
      const days = [...m[1].matchAll(new RegExp(DAY, 'gi'))].map((d) => WEEKDAYS[weekdayIndexOf(d[0])]);
      setRepeat({ freq: 'weekly', weekdays: WEEKDAYS.filter((d) => days.includes(d)) });
    }) ||
    take(word('(?:every\\s+(week|month)|(weekly|monthly))'), (m) => setRepeat({ freq: unitFreq(m[1] ?? m[2]) }));

  // Reminder time: 7am, 7:30 pm, 19:00, at 5 (1–6 means afternoon), noon
  const setTime = (t) => {
    if (!t) return false;
    out.remindAt = t;
    found.push('time');
  };
  take(word('(?:at\\s+)?(\\d{1,2})(?::([0-5]\\d))?\\s*(am|pm)'), (m) => {
    const h = Number(m[1]);
    if (h < 1 || h > 12) return false;
    return setTime(time((h % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0), Number(m[2] ?? 0)));
  }) ||
    take(word('(?:at\\s+)?([01]?\\d|2[0-3]):([0-5]\\d)'), (m) => setTime(time(Number(m[1]), Number(m[2])))) ||
    take(word('at\\s+(\\d{1,2})'), (m) => {
      const h = Number(m[1]);
      return setTime(time(h >= 1 && h <= 6 ? h + 12 : h, 0));
    }) ||
    take(word('(?:at\\s+)?(?:noon|midday)'), () => setTime('12:00'));

  // Day
  const setDay = (day) => {
    if (!day) return false;
    out.day = day;
    found.push('day');
  };
  take(word('(?:the\\s+)?day\\s+after\\s+tomorrow'), () => setDay(addDays(today, 2))) ||
    take(word('today'), () => setDay(today)) ||
    take(word('tonight'), () => {
      setDay(today);
      if (!out.remindAt) setTime('20:00');
    }) ||
    take(word('(?:tomorrow|tmrw?|tmr)'), () => setDay(addDays(today, 1))) ||
    take(word('in\\s+(\\d{1,3})\\s+(days?|weeks?)'), (m) => setDay(addDays(today, Number(m[1]) * (/^w/i.test(m[2]) ? 7 : 1)))) ||
    take(word('next\\s+week'), () => setDay(addDays(today, 7 - weekdayOf(today)))) ||
    take(word(`(?:(?:on|from|starting)\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}(?:,?\\s+(\\d{4}))?`), (m) =>
      setDay(upcoming(today, monthNumber(m[2]), Number(m[1]), m[3] && Number(m[3]))),
    ) ||
    take(word(`(?:(?:on|from|starting)\\s+)?${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`), (m) =>
      setDay(upcoming(today, monthNumber(m[1]), Number(m[2]), m[3] && Number(m[3]))),
    ) ||
    // 25/10 or 25-10-2026: day first, as written in India
    take(word('(?:(?:on|from|starting)\\s+)?(\\d{1,2})[/-](\\d{1,2})(?:[/-](\\d{2}|\\d{4}))?'), (m) =>
      setDay(upcoming(today, Number(m[2]), Number(m[1]), m[3] && Number(m[3]))),
    ) ||
    take(word(`(?:(?:on|this)\\s+)?(next\\s+)?(${DAY})`), (m) => {
      // A weekday means the next one; today counts unless it says "next".
      let diff = (weekdayIndexOf(m[2]) - weekdayOf(today) + 7) % 7;
      if (m[1] && diff === 0) diff = 7;
      setDay(addDays(today, diff));
    });

  const title = rest
    .replace(/\s+/g, ' ')
    .replace(/(^|\s)(on|at|by)\s*$/i, '')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim();
  return { title, ...out, found };
}

function unitFreq(unit) {
  const u = unit.toLowerCase();
  if (u.startsWith('day')) return 'daily';
  if (u.startsWith('week')) return 'weekly';
  return 'monthly';
}

const monthNumber = (name) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
