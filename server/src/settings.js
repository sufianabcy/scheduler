// When each user gets the two daily notifications. Users without a saved row get the defaults.

const DEFAULTS = { evening_on: 1, evening_time: '23:00', morning_on: 1, morning_time: '06:00' };

const json = (row) => ({
  eveningReminder: { on: row.evening_on === 1, time: row.evening_time },
  morningSummary: { on: row.morning_on === 1, time: row.morning_time },
});

export function createSettings(db) {
  const q = {
    get: db.prepare('SELECT * FROM notification_settings WHERE user_id = ?'),
    save: db.prepare(`
      INSERT INTO notification_settings (user_id, evening_on, evening_time, morning_on, morning_time)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET evening_on = excluded.evening_on, evening_time = excluded.evening_time,
        morning_on = excluded.morning_on, morning_time = excluded.morning_time`),
  };

  const row = (userId) => q.get.get(userId) ?? DEFAULTS;

  return {
    row,
    get: (userId) => json(row(userId)),

    /** changes: { eveningReminder?: { on?, time? }, morningSummary?: { on?, time? } } */
    update(userId, { eveningReminder = {}, morningSummary = {} }) {
      const r = row(userId);
      q.save.run(
        userId,
        eveningReminder.on === undefined ? r.evening_on : Number(eveningReminder.on),
        eveningReminder.time ?? r.evening_time,
        morningSummary.on === undefined ? r.morning_on : Number(morningSummary.on),
        morningSummary.time ?? r.morning_time,
      );
      return json(row(userId));
    },
  };
}
