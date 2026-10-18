import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseQuickAdd } from '../src/quickadd.js';

// 2026-10-15 is a Thursday.
const TODAY = '2026-10-15';
const parse = (text, today = TODAY) => {
  const { found, ...rest } = parseQuickAdd(text, today);
  return rest;
};
const none = { day: null, remindAt: null, repeat: null, priority: null };

describe('quick add', () => {
  test('the example: gym tomorrow 7am every mon wed', () => {
    assert.deepEqual(parse('gym tomorrow 7am every mon wed'), {
      title: 'gym',
      day: '2026-10-16',
      remindAt: '07:00',
      repeat: { freq: 'weekly', every: 1, weekdays: ['mon', 'wed'], until: null },
      priority: null,
    });
  });

  test('plain text stays as it is', () => {
    assert.deepEqual(parse('Read 20 pages of Clean Code'), { title: 'Read 20 pages of Clean Code', ...none });
    assert.deepEqual(parse('Fix everything'), { title: 'Fix everything', ...none });
    assert.deepEqual(parse('Buy p100 masks'), { title: 'Buy p100 masks', ...none });
  });

  test('priority', () => {
    assert.deepEqual(parse('Pay rent p1'), { title: 'Pay rent', ...none, priority: 1 });
    assert.equal(parse('P3 tidy desk').priority, 3);
  });

  test('times', () => {
    assert.equal(parse('call 7:30pm').remindAt, '19:30');
    assert.equal(parse('call at 12am').remindAt, '00:00');
    assert.equal(parse('call at 12pm').remindAt, '12:00');
    assert.equal(parse('call 18:45').remindAt, '18:45');
    assert.equal(parse('call at 5').remindAt, '17:00', '1–6 without am/pm means afternoon');
    assert.equal(parse('call at 9').remindAt, '09:00');
    assert.equal(parse('lunch at noon').remindAt, '12:00');
    assert.equal(parse('call at 5').title, 'call');
    assert.equal(parse('room 13pm').remindAt, null, 'not a real time');
  });

  test('days', () => {
    assert.equal(parse('x today').day, TODAY);
    assert.equal(parse('x tmrw').day, '2026-10-16');
    assert.equal(parse('x day after tomorrow').day, '2026-10-17');
    assert.equal(parse('x in 3 days').day, '2026-10-18');
    assert.equal(parse('x in 2 weeks').day, '2026-10-29');
    assert.equal(parse('x next week').day, '2026-10-19', 'next Monday');
    assert.equal(parse('x monday').day, '2026-10-19');
    assert.equal(parse('x on thu').day, TODAY, 'today is Thursday');
    assert.equal(parse('x next thursday').day, '2026-10-22');
  });

  test('dates, never in the past', () => {
    assert.equal(parse('x 25 oct').day, '2026-10-25');
    assert.equal(parse('x on Oct 25th').day, '2026-10-25');
    assert.equal(parse('x 3 jan').day, '2027-01-03');
    assert.equal(parse('x 1 oct').day, '2027-10-01', 'already passed this year');
    assert.equal(parse('x 25/12').day, '2026-12-25', 'day first');
    assert.equal(parse('x 5-1-2027').day, '2027-01-05');
    assert.equal(parse('x 31/2').day, null, 'not a real date');
    assert.equal(parse('x 31/2').title, 'x 31/2');
  });

  test('tonight sets an evening reminder unless a time is given', () => {
    assert.deepEqual(parse('movie tonight'), { title: 'movie', ...none, day: TODAY, remindAt: '20:00' });
    assert.equal(parse('movie tonight 9pm').remindAt, '21:00');
  });

  test('repeats', () => {
    const r = (text) => parse(text).repeat;
    assert.deepEqual(r('water plants daily'), { freq: 'daily', every: 1, weekdays: [], until: null });
    assert.deepEqual(r('standup every weekday'), { freq: 'weekly', every: 1, weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'], until: null });
    assert.deepEqual(r('clean every 2 weeks'), { freq: 'weekly', every: 2, weekdays: [], until: null });
    assert.deepEqual(r('call mom every other day'), { freq: 'daily', every: 2, weekdays: [], until: null });
    assert.deepEqual(r('rent monthly'), { freq: 'monthly', every: 1, weekdays: [], until: null });
    assert.deepEqual(r('swim every tue, thu and sat'), { freq: 'weekly', every: 1, weekdays: ['tue', 'thu', 'sat'], until: null });
    assert.equal(parse('swim every tue, thu and sat').title, 'swim');
  });

  test('everything at once, in any order', () => {
    assert.deepEqual(parse('p2 every monday at 6:30am team sync from 20 oct'), {
      title: 'team sync',
      day: '2026-10-20',
      remindAt: '06:30',
      repeat: { freq: 'weekly', every: 1, weekdays: ['mon'], until: null },
      priority: 2,
    });
  });

  test('if only date words were typed, the title is empty (the app then keeps the text as is)', () => {
    assert.equal(parse('tomorrow').title, '');
  });
});
