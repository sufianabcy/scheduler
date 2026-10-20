import { transaction } from '../db.js';
import { HttpError, badRequest, notFound } from '../http.js';
import { createTokenBox, loadKey } from '../mail/crypto.js';
import { decodeEntities } from '../mail/http.js';
import { dayOf } from '../time.js';
import { LmsError, createLmsClient, isTokenError } from './client.js';

export const SYNC_EVERY_MS = 2 * 60 * 60 * 1000;
// Opening the app syncs at most this often; "Sync now" at most every 20 seconds.
export const AUTO_SYNC_EVERY_MS = 10 * 60 * 1000;
const SYNC_NOW_EVERY_MS = 20_000;
// How far back to look when no semester start is set.
export const LOOKBACK_DAYS = 180;
const EVENTS_PAGE = 50;
const MAX_EVENT_PAGES = 20;
const OPEN = ['upcoming', 'overdue'];
// How many pieces of upcoming work the Today page lists.
const TODAY_UPCOMING = 5;
// Activities whose submission or attempts can be looked up; anything else is followed through the calendar only.
const CHECKED_KINDS = { assign: 'mod_assign_get_submission_status', quiz: 'mod_quiz_get_user_attempts' };

// The web-service functions the sync uses. The LMS decides which of them a token may call; missing ones are skipped.
export const FUNCTIONS = [
  'core_webservice_get_site_info',
  'core_course_get_enrolled_courses_by_timeline_classification',
  'core_enrol_get_users_courses',
  'core_calendar_get_action_events_by_timesort',
  'mod_assign_get_assignments',
  'mod_assign_get_submission_status',
  'mod_quiz_get_quizzes_by_courses',
  'mod_quiz_get_user_attempts',
];

/** The LMS sign-in stopped working; the user has to connect again. */
class NeedsReconnect extends Error {}

const fromSeconds = (s) => (Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null);
// Moodle sends names with HTML entities (and grades as HTML): plain text for the app.
const stripHtml = (s) => decodeEntities(String(s ?? '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
/** The course module id from an activity link like .../mod/assign/view.php?id=4182. */
const cmidFromUrl = (url) => {
  const m = /\/mod\/[a-z]+\/view\.php\?(?:.*&)?id=(\d+)/.exec(url ?? '');
  return m ? Number(m[1]) : null;
};

/** upcoming / overdue / missed from the dates alone (done is only ever set from a submission or attempt). */
export function statusAt({ dueAt, cutoffAt }, nowIso) {
  if (!dueAt || dueAt > nowIso) return 'upcoming';
  if (!cutoffAt || cutoffAt > nowIso) return 'overdue';
  return 'missed';
}

const itemJson = (i) => ({
  id: i.id,
  courseId: i.course_id,
  course: i.course_name,
  courseShort: i.short_name ?? null,
  projectId: i.project_id ?? null,
  kind: i.kind,
  title: i.title,
  url: i.url,
  opensAt: i.opens_at,
  dueAt: i.due_at,
  cutoffAt: i.cutoff_at,
  status: i.status,
  submittedAt: i.submitted_at,
  grade: i.grade,
  taskId: i.task_id,
});

const courseJson = (c) => ({
  id: c.course_id,
  name: c.name,
  shortName: c.short_name,
  projectId: c.project_id,
  hidden: c.hidden === 1,
  open: c.open ?? 0,
  missed: c.missed ?? 0,
});

/**
 * KL University LMS (Moodle): signs in once with the user's LMS username and password to get a web-service token
 * (only the token is kept, encrypted), then syncs what's due: upcoming, overdue and missed work, and what's done.
 * Upcoming and overdue work gets a planner task on its due day, ticked by itself once it's submitted.
 * Switched off (`enabled` false) until LMS_TOKEN_KEY is set. `client` and `push` can be swapped in tests.
 */
export function createLms(db, { config, now = () => new Date(), client, push = null } = {}) {
  const key = loadKey(config.lms?.tokenKey, 'LMS_TOKEN_KEY');
  const box = key ? createTokenBox(key) : null;
  const enabled = box !== null;
  const lmsUrl = config.lms?.url ?? 'https://lms.kluniversity.in';
  client ??= createLmsClient({ baseUrl: lmsUrl });
  // Syncs running right now, by user id. Background ones (after connecting, on app open) are kept for settled().
  const running = new Map();
  const background = new Set();
  let ticking = false;

  const q = {
    account: db.prepare('SELECT * FROM lms_accounts WHERE user_id = ?'),
    due: db.prepare(`SELECT user_id FROM lms_accounts WHERE status = 'ok' AND (last_synced_at IS NULL OR last_synced_at <= ?) ORDER BY last_synced_at`),
    saveAccount: db.prepare(`
      INSERT INTO lms_accounts (user_id, token, moodle_user_id, functions) VALUES (?, ?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET token = excluded.token, moodle_user_id = excluded.moodle_user_id,
        functions = excluded.functions, status = 'ok', last_error = NULL`),
    setFunctions: db.prepare('UPDATE lms_accounts SET functions = ? WHERE user_id = ?'),
    setSemester: db.prepare('UPDATE lms_accounts SET semester_start = ? WHERE user_id = ?'),
    synced: db.prepare('UPDATE lms_accounts SET last_synced_at = ?, last_error = NULL WHERE user_id = ?'),
    failed: db.prepare('UPDATE lms_accounts SET last_synced_at = ?, last_error = ? WHERE user_id = ?'),
    needsReconnect: db.prepare(`UPDATE lms_accounts SET status = 'needs_reconnect', last_error = ? WHERE user_id = ?`),
    removeAccount: db.prepare('DELETE FROM lms_accounts WHERE user_id = ?'),
    removeItems: db.prepare('DELETE FROM lms_items WHERE user_id = ?'),
    removeCourses: db.prepare('DELETE FROM lms_courses WHERE user_id = ?'),

    courses: db.prepare(`
      SELECT c.*,
        (SELECT count(*) FROM lms_items i WHERE i.user_id = c.user_id AND i.course_id = c.course_id AND i.status IN ('upcoming', 'overdue')) AS open,
        (SELECT count(*) FROM lms_items i WHERE i.user_id = c.user_id AND i.course_id = c.course_id AND i.status = 'missed') AS missed
      FROM lms_courses c WHERE c.user_id = ? ORDER BY c.hidden, c.name`),
    course: db.prepare('SELECT * FROM lms_courses WHERE user_id = ? AND course_id = ?'),
    upsertCourse: db.prepare(`
      INSERT INTO lms_courses (user_id, course_id, name, short_name) VALUES (?, ?, ?, ?)
      ON CONFLICT (user_id, course_id) DO UPDATE SET name = excluded.name, short_name = coalesce(excluded.short_name, short_name)`),
    listsDue: db.prepare('SELECT course_id FROM lms_courses WHERE user_id = ? AND hidden = 0 AND (lists_day IS NULL OR lists_day != ?)'),
    forgetLists: db.prepare('UPDATE lms_courses SET lists_day = NULL WHERE user_id = ?'),
    listsFetched: db.prepare('UPDATE lms_courses SET lists_day = ? WHERE user_id = ? AND course_id = ?'),
    updateCourse: db.prepare('UPDATE lms_courses SET project_id = ?, hidden = ? WHERE user_id = ? AND course_id = ?'),
    project: db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?'),

    item: db.prepare('SELECT * FROM lms_items WHERE user_id = ? AND id = ?'),
    insertItem: db.prepare(`
      INSERT INTO lms_items (user_id, id, course_id, course_name, kind, instance_id, title, url, opens_at, due_at, cutoff_at, status, missed_sent, last_seen_at)
      VALUES (:user, :id, :course, :courseName, :kind, :instance, :title, :url, :opens, :due, :cutoff, :status, :missedSent, :seen)`),
    updateItem: db.prepare(`
      UPDATE lms_items SET course_id = :course, course_name = :courseName, kind = :kind, instance_id = coalesce(:instance, instance_id),
        title = :title, url = coalesce(:url, url), opens_at = coalesce(:opens, opens_at), due_at = :due,
        cutoff_at = CASE WHEN :keepCutoff = 1 THEN cutoff_at ELSE :cutoff END, last_seen_at = :seen
      WHERE user_id = :user AND id = :id`),
    toCheck: db.prepare(`
      SELECT i.* FROM lms_items i JOIN lms_courses c ON c.user_id = i.user_id AND c.course_id = i.course_id
      WHERE i.user_id = ? AND c.hidden = 0 AND i.kind IN ('assign', 'quiz') AND i.instance_id IS NOT NULL
        AND (i.checked_at IS NULL OR i.status IN ('upcoming', 'overdue'))
      ORDER BY i.due_at`),
    checked: db.prepare(`
      UPDATE lms_items SET checked_at = :at, submitted_at = :submittedAt, grade = :grade,
        due_at = coalesce(:due, due_at), cutoff_at = CASE WHEN :cutoff IS NOT NULL AND (cutoff_at IS NULL OR cutoff_at < :cutoff) THEN :cutoff ELSE cutoff_at END,
        status = CASE WHEN :done = 1 THEN 'done' WHEN status = 'done' THEN 'upcoming' ELSE status END
      WHERE user_id = :user AND id = :id`),
    // Activities followed through the calendar only: gone from it means done (or missed, if its time ran out).
    calendarOnly: db.prepare(`
      SELECT * FROM lms_items WHERE user_id = ? AND status IN ('upcoming', 'overdue') AND checked_at IS NULL`),
    setStatus: db.prepare('UPDATE lms_items SET status = ? WHERE user_id = ? AND id = ?'),
    recompute: db.prepare(`
      UPDATE lms_items SET status = CASE
          WHEN due_at IS NULL OR due_at > :now THEN 'upcoming'
          WHEN cutoff_at IS NULL OR cutoff_at > :now THEN 'overdue'
          ELSE 'missed' END
      WHERE user_id = :user AND status != 'done'`),
    newlyMissed: db.prepare(`
      SELECT i.* FROM lms_items i JOIN lms_courses c ON c.user_id = i.user_id AND c.course_id = i.course_id
      WHERE i.user_id = ? AND i.status = 'missed' AND i.missed_sent = 0 AND c.hidden = 0 ORDER BY i.due_at`),
    markMissedSent: db.prepare("UPDATE lms_items SET missed_sent = 1 WHERE user_id = ? AND status = 'missed'"),
    items: db.prepare(`
      SELECT i.*, c.short_name, c.project_id FROM lms_items i JOIN lms_courses c ON c.user_id = i.user_id AND c.course_id = i.course_id
      WHERE i.user_id = ? AND c.hidden = 0 AND i.status IN (SELECT value FROM json_each(?))
      ORDER BY CASE WHEN i.status IN ('missed', 'done') THEN 1 ELSE 0 END,
        CASE WHEN i.status IN ('missed', 'done') THEN -unixepoch(i.due_at) ELSE unixepoch(i.due_at) END, i.title`),
    counts: db.prepare(`
      SELECT i.status, count(*) AS n FROM lms_items i JOIN lms_courses c ON c.user_id = i.user_id AND c.course_id = i.course_id
      WHERE i.user_id = ? AND c.hidden = 0 GROUP BY i.status`),
    dueBetween: db.prepare(`
      SELECT i.* FROM lms_items i JOIN lms_courses c ON c.user_id = i.user_id AND c.course_id = i.course_id
      WHERE i.user_id = ? AND c.hidden = 0 AND i.status IN ('upcoming', 'overdue') AND i.due_at >= ? AND i.due_at < ?
      ORDER BY i.due_at`),

    // Planner tasks for upcoming and overdue work.
    needTasks: db.prepare(`
      SELECT i.* FROM lms_items i JOIN lms_courses c ON c.user_id = i.user_id AND c.course_id = i.course_id
      WHERE i.user_id = ? AND c.hidden = 0 AND i.status IN ('upcoming', 'overdue') AND i.task_made = 0 AND i.due_at IS NOT NULL`),
    insertTask: db.prepare(`
      INSERT INTO daily_tasks (user_id, title, day, position)
      VALUES (?, ?, ?, (SELECT coalesce(max(position), -1) + 1 FROM daily_tasks WHERE user_id = ? AND day = ?))`),
    linkTask: db.prepare('UPDATE lms_items SET task_id = ?, task_made = 1 WHERE user_id = ? AND id = ?'),
    linkedTasks: db.prepare(`
      SELECT i.id, i.status, i.due_at, t.id AS task_id, t.day, t.status AS task_status
      FROM lms_items i JOIN daily_tasks t ON t.id = i.task_id
      WHERE i.user_id = ? AND t.status IN ('open', 'unfinished')`),
    taskDone: db.prepare(`UPDATE daily_tasks SET status = 'done', done_at = datetime('now'), day = max(day, ?) WHERE id = ?`),
    taskMove: db.prepare(`UPDATE daily_tasks SET day = ?, status = 'open', reminded_at = NULL WHERE id = ?`),
    removeTask: db.prepare('DELETE FROM daily_tasks WHERE id = ?'),
    // Hiding a course takes its open tasks off the plan; showing it again brings back those tasks (and only those:
    // a task you deleted yourself stays deleted). task_made = 2 marks "taken off by hiding".
    markHiddenTasks: db.prepare(`
      UPDATE lms_items SET task_made = 2 WHERE user_id = ? AND course_id = ?
        AND task_id IN (SELECT id FROM daily_tasks WHERE status IN ('open', 'unfinished'))`),
    hideTasks: db.prepare(`
      DELETE FROM daily_tasks WHERE status IN ('open', 'unfinished')
        AND id IN (SELECT task_id FROM lms_items WHERE user_id = ? AND course_id = ? AND task_id IS NOT NULL)`),
    resetTaskMade: db.prepare(`UPDATE lms_items SET task_made = 0 WHERE user_id = ? AND course_id = ? AND task_made = 2`),
  };

  const nowIso = () => now().toISOString();

  function ensureEnabled() {
    if (!enabled) throw new HttpError(503, 'The LMS is not set up on the server yet (LMS_TOKEN_KEY is missing)');
  }

  function owned(userId) {
    const account = q.account.get(userId);
    if (!account) throw notFound('The LMS is not connected');
    return account;
  }

  /** Where to start looking: the semester start if set, otherwise 180 days ago. */
  function since(account) {
    if (account.semester_start) return new Date(`${account.semester_start}T00:00:00+05:30`);
    return new Date(now().getTime() - LOOKBACK_DAYS * 86_400_000);
  }

  function status(userId) {
    const account = q.account.get(userId);
    const base = { enabled, lmsUrl, connected: Boolean(account) };
    if (!account) return base;
    const functions = JSON.parse(account.functions);
    const counts = Object.fromEntries(q.counts.all(userId).map((r) => [r.status, r.n]));
    return {
      ...base,
      status: account.status,
      lastSyncedAt: account.last_synced_at,
      lastError: account.last_error,
      semesterStart: account.semester_start,
      lookbackDays: LOOKBACK_DAYS,
      syncing: running.has(userId),
      counts: { upcoming: counts.upcoming ?? 0, overdue: counts.overdue ?? 0, missed: counts.missed ?? 0, done: counts.done ?? 0 },
      // Functions this sync would like but the LMS doesn't allow for this token (an empty list means it didn't say).
      missingFunctions: functions.length ? FUNCTIONS.filter((f) => !functions.includes(f)) : [],
    };
  }

  /** Recomputes upcoming / overdue / missed from the clock. Cheap; run before anything is shown. */
  function recompute(userId) {
    q.recompute.run({ now: nowIso(), user: userId });
  }

  async function notify(userId, message) {
    if (!push) return;
    try {
      await push.sendTo(userId, message, { ttl: 12 * 60 * 60 });
    } catch (err) {
      console.error(`LMS notification failed for user ${userId}: ${err.statusCode ?? err.name}`);
    }
  }

  async function markNeedsReconnect(userId, reason) {
    const account = q.account.get(userId);
    q.needsReconnect.run(reason, userId);
    if (account?.status === 'ok') {
      await notify(userId, {
        title: 'Reconnect LMS',
        body: 'The LMS sign-in stopped working. Open More → LMS and sign in again.',
        url: '/#/lms',
        tag: 'lms-reconnect',
      });
    }
  }

  // ---------- Sync ----------

  /** Saves one activity. New ones get their status from the dates; ones already missed when first seen send nothing. */
  function saveItem(userId, item, seen) {
    const existing = q.item.get(userId, item.id);
    const row = {
      user: userId,
      id: item.id,
      course: item.courseId,
      courseName: item.courseName,
      kind: item.kind,
      instance: item.instanceId ?? null,
      title: item.title.slice(0, 300),
      url: item.url ?? null,
      opens: item.opensAt ?? null,
      due: item.dueAt,
      cutoff: item.cutoffAt ?? null,
      seen,
    };
    if (existing) {
      // The calendar doesn't know cutoffs: a calendar-only update keeps the one the module list gave.
      q.updateItem.run({ ...row, keepCutoff: item.fromCalendar ? 1 : 0 });
    } else {
      const s = statusAt({ dueAt: row.due, cutoffAt: row.cutoff }, seen);
      q.insertItem.run({ ...row, status: s, missedSent: s === 'missed' ? 1 : 0 });
    }
  }

  /** Every web-service call goes through here: a dead token stops the sync; other errors are the caller's. */
  function caller(token, allowed) {
    const can = (fn) => allowed.size === 0 || allowed.has(fn);
    const call = async (fn, params) => {
      try {
        return await client.call(token, fn, params);
      } catch (err) {
        if (isTokenError(err)) throw new NeedsReconnect();
        throw err;
      }
    };
    // For optional calls: unavailable or refused functions give null instead of stopping the sync.
    const optional = async (fn, params) => {
      if (!can(fn)) return null;
      try {
        return await call(fn, params);
      } catch (err) {
        if (err instanceof LmsError && !['network', 'http', 'notjson'].includes(err.code)) {
          console.error(`LMS ${fn} refused: ${err.code}`);
          return null;
        }
        throw err;
      }
    };
    return { call, optional, can };
  }

  async function fetchCourses(api, moodleUserId) {
    const timeline = await api.optional('core_course_get_enrolled_courses_by_timeline_classification', { classification: 'inprogress', limit: 0, offset: 0 });
    if (timeline?.courses) return timeline.courses;
    const all = await api.optional('core_enrol_get_users_courses', { userid: moodleUserId });
    if (!Array.isArray(all)) return [];
    // Without the timeline call, keep courses that haven't ended.
    const nowS = now().getTime() / 1000;
    return all.filter((c) => !c.enddate || c.enddate > nowS);
  }

  async function fetchEvents(api, fromSeconds) {
    const events = [];
    let after = null;
    for (let page = 0; page < MAX_EVENT_PAGES; page++) {
      const res = await api.optional('core_calendar_get_action_events_by_timesort', {
        timesortfrom: fromSeconds,
        limittononsuspendedevents: 1,
        limitnum: EVENTS_PAGE,
        ...(after !== null && { aftereventid: after }),
      });
      if (!res) return page === 0 ? null : events;
      const batch = res.events ?? [];
      events.push(...batch);
      if (batch.length < EVENTS_PAGE) break;
      after = res.lastid ?? batch[batch.length - 1].id;
    }
    return events;
  }

  /** Looks up whether an assignment was submitted or a quiz attempted. Returns null if it can't tell. */
  async function checkOne(api, item) {
    if (item.kind === 'assign') {
      const res = await api.optional('mod_assign_get_submission_status', { assignid: item.instance_id });
      if (!res) return null;
      const attempt = res.lastattempt ?? {};
      const sub = [attempt.submission, attempt.teamsubmission].find((s) => s?.status === 'submitted');
      const grade = stripHtml(res.feedback?.gradefordisplay).slice(0, 60) || null;
      return {
        done: Boolean(sub),
        submittedAt: sub ? fromSeconds(sub.timemodified) : null,
        grade,
        // An extension moves the due date (and the cut-off, if it was earlier).
        due: fromSeconds(attempt.extensionduedate),
        cutoff: fromSeconds(attempt.extensionduedate),
      };
    }
    const res = await api.optional('mod_quiz_get_user_attempts', { quizid: item.instance_id, status: 'all', includepreviews: 0 });
    if (!res) return null;
    const finished = (res.attempts ?? []).filter((a) => a.state === 'finished');
    const last = finished[finished.length - 1];
    return { done: finished.length > 0, submittedAt: last ? fromSeconds(last.timefinish) : null, grade: null, due: null, cutoff: null };
  }

  /**
   * Makes, moves, ticks or removes planner tasks to match the LMS. A task the user ticked is never unticked, and one
   * they moved to today or a later day stays there: only tasks left on a past day (or in Unfinished) are moved.
   */
  function syncTasks(userId) {
    const today = dayOf(now());
    for (const item of q.needTasks.all(userId)) {
      const dueDay = dayOf(new Date(item.due_at));
      const day = dueDay < today ? today : dueDay;
      const { lastInsertRowid } = q.insertTask.run(userId, item.title.slice(0, 200), day, userId, day);
      q.linkTask.run(Number(lastInsertRowid), userId, item.id);
    }
    for (const t of q.linkedTasks.all(userId)) {
      if (t.status === 'done') q.taskDone.run(today, t.task_id);
      else if (t.status === 'missed') q.removeTask.run(t.task_id);
      else if (t.day < today || t.task_status !== 'open') {
        const dueDay = dayOf(new Date(t.due_at));
        q.taskMove.run(t.status === 'overdue' || dueDay < today ? today : dueDay, t.task_id);
      }
    }
  }

  async function runSync(userId) {
    const account = q.account.get(userId);
    if (!account || account.status !== 'ok') return { ok: false };
    let token;
    try {
      token = box.open(account.token);
    } catch {
      await markNeedsReconnect(userId, 'The saved LMS sign-in could not be read (LMS_TOKEN_KEY changed)');
      return { ok: false, needsReconnect: true };
    }

    const started = nowIso();
    try {
      // Site info first: it fails fast on a dead token and says which functions this token may call.
      let info;
      try {
        info = await client.call(token, 'core_webservice_get_site_info');
      } catch (err) {
        if (err instanceof LmsError && ['invalidtoken', 'accessexception'].includes(err.code)) throw new NeedsReconnect();
        throw err;
      }
      const functions = (info.functions ?? []).map((f) => f.name);
      q.setFunctions.run(JSON.stringify(functions), userId);
      const api = caller(token, new Set(functions));
      const from = since(account);
      const today = dayOf(now());

      const courses = await fetchCourses(api, info.userid ?? account.moodle_user_id);
      const events = await fetchEvents(api, Math.floor(from.getTime() / 1000));

      const courseName = new Map(courses.map((c) => [c.id, stripHtml(c.fullname)]));
      transaction(db, () => {
        for (const c of courses) q.upsertCourse.run(userId, c.id, courseName.get(c.id) || `Course ${c.id}`, c.shortname ?? null);
        for (const ev of events ?? []) {
          if (!ev.course?.id) continue;
          courseName.set(ev.course.id, stripHtml(ev.course.fullname));
          q.upsertCourse.run(userId, ev.course.id, courseName.get(ev.course.id) || `Course ${ev.course.id}`, ev.course.shortname ?? null);
        }
      });

      // Assignment and quiz lists, at most once a day per course (only current courses when the LMS listed them).
      const current = new Set(courses.map((c) => c.id));
      const dueLists = q.listsDue.all(userId, today).map((r) => r.course_id).filter((id) => current.size === 0 || current.has(id));
      const assignments = dueLists.length ? await api.optional('mod_assign_get_assignments', { courseids: dueLists }) : null;
      const quizzes = dueLists.length ? await api.optional('mod_quiz_get_quizzes_by_courses', { courseids: dueLists }) : null;

      const fromIso = from.toISOString();
      const seen = nowIso();
      const calendarIds = new Set();
      const nameOf = (id) => courseName.get(id) || `Course ${id}`;

      transaction(db, () => {
        for (const course of assignments?.courses ?? []) {
          for (const a of course.assignments ?? []) {
            const due = fromSeconds(a.duedate);
            if (!due || due < fromIso || a.nosubmissions) continue;
            saveItem(userId, {
              id: `assign:${a.cmid}`,
              courseId: course.id,
              courseName: nameOf(course.id),
              kind: 'assign',
              instanceId: a.id,
              title: stripHtml(a.name),
              url: `${lmsUrl}/mod/assign/view.php?id=${a.cmid}`,
              opensAt: fromSeconds(a.allowsubmissionsfromdate),
              dueAt: due,
              cutoffAt: fromSeconds(a.cutoffdate),
            }, seen);
          }
        }
        for (const quiz of quizzes?.quizzes ?? []) {
          const close = fromSeconds(quiz.timeclose);
          if (!close || close < fromIso) continue;
          saveItem(userId, {
            id: `quiz:${quiz.coursemodule}`,
            courseId: quiz.course,
            courseName: nameOf(quiz.course),
            kind: 'quiz',
            instanceId: quiz.id,
            title: stripHtml(quiz.name),
            url: `${lmsUrl}/mod/quiz/view.php?id=${quiz.coursemodule}`,
            opensAt: fromSeconds(quiz.timeopen),
            dueAt: close,
            // A quiz can't be attempted after it closes.
            cutoffAt: close,
          }, seen);
        }
        if (assignments || quizzes) for (const id of dueLists) q.listsFetched.run(today, userId, id);

        // The Dashboard timeline: everything that still needs doing, including overdue work.
        for (const ev of events ?? []) {
          const kind = ev.modulename || 'other';
          const cmid = cmidFromUrl(ev.url) ?? cmidFromUrl(ev.action?.url);
          if (!ev.course?.id || !ev.timesort) continue;
          const id = cmid ? `${kind}:${cmid}` : `event:${ev.id}`;
          calendarIds.add(id);
          saveItem(userId, {
            id,
            courseId: ev.course.id,
            courseName: nameOf(ev.course.id),
            kind,
            // Not ev.instance: on this LMS it's the course module id, not the assignment or quiz id. The id that
            // submission checks need comes from the module lists only.
            instanceId: null,
            title: stripHtml(ev.activityname || ev.name),
            url: ev.url || ev.action?.url || null,
            dueAt: fromSeconds(ev.timesort),
            cutoffAt: kind === 'quiz' ? fromSeconds(ev.timesort) : null,
            fromCalendar: true,
          }, seen);
        }
        recompute(userId);
      });

      // Submissions and attempts, one call at a time, only for work that isn't done yet (or never looked up).
      const checkable = (kind) => api.can(CHECKED_KINDS[kind]);
      for (const item of q.toCheck.all(userId)) {
        if (!checkable(item.kind)) continue;
        const result = await checkOne(api, item);
        if (!result) continue;
        q.checked.run({ at: nowIso(), user: userId, id: item.id, done: Number(result.done), submittedAt: result.submittedAt, grade: result.grade, due: result.due, cutoff: result.cutoff });
      }

      const newlyMissed = transaction(db, () => {
        // Work only known from the calendar: once it drops off, it was done (or its time ran out).
        if (events) {
          for (const item of q.calendarOnly.all(userId)) {
            if (calendarIds.has(item.id) || (CHECKED_KINDS[item.kind] && checkable(item.kind) && item.instance_id !== null)) continue;
            // Missed only if its cut-off passed (as recompute below sees it too); work with no cut-off that drops off
            // the timeline was handed in, since the timeline keeps listing work that's overdue but still accepted.
            q.setStatus.run(statusAt({ dueAt: item.due_at, cutoffAt: item.cutoff_at }, nowIso()) === 'missed' ? 'missed' : 'done', userId, item.id);
          }
        }
        recompute(userId);
        syncTasks(userId);
        const missed = q.newlyMissed.all(userId);
        q.markMissedSent.run(userId);
        q.synced.run(nowIso(), userId);
        return missed;
      });

      if (newlyMissed.length > 0) {
        const titles = newlyMissed.map((i) => i.title);
        await notify(userId, {
          title: newlyMissed.length === 1 ? `Missed on LMS: ${titles[0]}` : `Missed on LMS: ${newlyMissed.length} items`,
          body: newlyMissed.length === 1 ? `${newlyMissed[0].course_name} · the deadline has passed` : titles.slice(0, 3).join(' · '),
          url: '/#/lms/missed',
          tag: 'lms-missed',
        });
      }
      return { ok: true, started };
    } catch (err) {
      if (err instanceof NeedsReconnect) {
        await markNeedsReconnect(userId, 'The LMS sign-in stopped working; connect again');
        return { ok: false, needsReconnect: true };
      }
      // Never log the token: the user id and Moodle's error code are enough to look into it.
      console.error(`LMS sync failed for user ${userId}: ${err.code ?? err.name}`);
      const message = err instanceof LmsError ? err.message : 'Something went wrong while syncing';
      q.failed.run(nowIso(), message.slice(0, 300), userId);
      return { ok: false, error: message };
    }
  }

  /** One sync per user at a time: a second call while one runs waits for it. */
  function sync(userId) {
    if (running.has(userId)) return running.get(userId);
    const job = runSync(userId).finally(() => running.delete(userId));
    running.set(userId, job);
    return job;
  }

  function inBackground(userId) {
    const job = sync(userId).finally(() => background.delete(job));
    background.add(job);
  }

  return {
    enabled,
    status,
    recompute,

    /**
     * Signs in with the LMS username and password to get a token. Only the token is kept (encrypted); the password
     * is used for this one request and never stored or logged. The first sync starts in the background.
     */
    async connect(userId, { username, password }) {
      ensureEnabled();
      let token;
      let info;
      try {
        token = await client.getToken(username, password);
        info = await client.call(token, 'core_webservice_get_site_info');
      } catch (err) {
        if (err instanceof LmsError && err.code === 'invalidlogin') throw badRequest('Wrong LMS username or password');
        console.error(`LMS connect failed for user ${userId}: ${err.code ?? err.name}`);
        throw new HttpError(502, err instanceof LmsError ? `The LMS said: ${err.message}` : "Couldn't connect to the LMS");
      }
      const previous = q.account.get(userId);
      transaction(db, () => {
        // Another LMS account than before: start again from scratch.
        if (previous && previous.moodle_user_id !== info.userid) {
          q.removeItems.run(userId);
          q.removeCourses.run(userId);
        }
        q.saveAccount.run(userId, box.seal(token), info.userid, JSON.stringify((info.functions ?? []).map((f) => f.name)));
      });
      inBackground(userId);
      return status(userId);
    },

    /** Forgets the token and everything synced. Planner tasks made from the LMS stay, as plain tasks. */
    disconnect(userId) {
      owned(userId);
      transaction(db, () => {
        q.removeItems.run(userId);
        q.removeCourses.run(userId);
        q.removeAccount.run(userId);
      });
    },

    /**
     * "Sync now" waits for the sync and answers the new status (skipped if it synced in the last 20 seconds).
     * `auto` (the app was opened) runs in the background, at most every 10 minutes.
     */
    async syncUser(userId, { auto = false } = {}) {
      // The app asks on every open; with nothing connected that's simply nothing to do.
      if (auto && (!enabled || !q.account.get(userId))) return status(userId);
      ensureEnabled();
      const account = owned(userId);
      if (account.status !== 'ok') return status(userId);
      const gap = auto ? AUTO_SYNC_EVERY_MS : SYNC_NOW_EVERY_MS;
      const recent = account.last_synced_at && Date.parse(account.last_synced_at) > now().getTime() - gap;
      if (!recent || running.has(userId)) {
        if (auto) inBackground(userId);
        else await sync(userId);
      }
      return status(userId);
    },

    sync,

    /** Resolves once background syncs have finished. */
    settled: () => Promise.all([...background]),

    /** Called every minute by the job timer: syncs accounts whose last sync is 2 hours old or more. */
    async runDue() {
      if (!enabled || ticking) return;
      ticking = true;
      try {
        const cutoff = new Date(now().getTime() - SYNC_EVERY_MS).toISOString();
        for (const { user_id: userId } of q.due.all(cutoff)) await sync(userId);
      } finally {
        ticking = false;
      }
    },

    /** status: 'open' (upcoming and overdue), 'upcoming', 'overdue', 'missed', 'done' or 'all'. */
    items(userId, which = 'open') {
      recompute(userId);
      const statuses = which === 'all' ? ['upcoming', 'overdue', 'missed', 'done'] : which === 'open' ? OPEN : [which];
      return q.items.all(userId, JSON.stringify(statuses)).map(itemJson);
    },

    courses: (userId) => q.courses.all(userId).map(courseJson),

    /** changes: { projectId?: id | null, hidden?: boolean } */
    updateCourse(userId, courseId, { projectId, hidden }) {
      const course = q.course.get(userId, courseId);
      if (!course) throw notFound('No such course');
      if (projectId !== undefined && projectId !== null && !q.project.get(projectId, userId)) throw notFound('No such project');
      const nextHidden = hidden === undefined ? course.hidden : Number(hidden);
      transaction(db, () => {
        q.updateCourse.run(projectId === undefined ? course.project_id : projectId, nextHidden, userId, courseId);
        if (nextHidden === 1 && course.hidden === 0) {
          q.markHiddenTasks.run(userId, courseId);
          q.hideTasks.run(userId, courseId);
        }
        if (nextHidden === 0 && course.hidden === 1) {
          q.resetTaskMade.run(userId, courseId);
          syncTasks(userId);
        }
      });
      return courseJson(q.courses.all(userId).find((c) => c.course_id === courseId));
    },

    /** semesterStart: 'YYYY-MM-DD' or null (180 days back). A new start re-reads the course lists on the next sync. */
    setSemesterStart(userId, semesterStart) {
      owned(userId);
      transaction(db, () => {
        q.setSemester.run(semesterStart, userId);
        q.forgetLists.run(userId);
      });
      return status(userId);
    },

    /**
     * For the Today page: whether to show the "Reconnect LMS" banner, and the LMS section: counts by status, the
     * next few pieces of upcoming work, and when it last synced. Call recompute first.
     */
    summary(userId) {
      const account = q.account.get(userId);
      if (!account) return { enabled, connected: false, needsReconnect: false };
      const counts = Object.fromEntries(q.counts.all(userId).map((r) => [r.status, r.n]));
      return {
        enabled,
        connected: true,
        needsReconnect: account.status === 'needs_reconnect',
        lastSyncedAt: account.last_synced_at,
        counts: { upcoming: counts.upcoming ?? 0, overdue: counts.overdue ?? 0, missed: counts.missed ?? 0, done: counts.done ?? 0 },
        upcoming: q.items.all(userId, JSON.stringify(['upcoming'])).slice(0, TODAY_UPCOMING).map(itemJson),
      };
    },

    /** Upcoming or overdue work due on an IST day, for the morning and evening notifications. */
    dueOn(userId, day) {
      if (!q.account.get(userId)) return [];
      recompute(userId);
      const start = new Date(`${day}T00:00:00+05:30`);
      const end = new Date(start.getTime() + 86_400_000);
      return q.dueBetween.all(userId, start.toISOString(), end.toISOString()).map(itemJson);
    },

    overdueCount(userId) {
      if (!q.account.get(userId)) return 0;
      recompute(userId);
      return q.counts.all(userId).find((r) => r.status === 'overdue')?.n ?? 0;
    },
  };
}
