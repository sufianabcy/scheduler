import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

// A stand-in for the KL University LMS (Moodle): login/token.php and the REST web service, answering from the JSON
// fixtures in fixtures/lms (Moodle's response shapes; names, ids and the site are made up). Tests change `state`
// to play out what happens on the LMS: a submission, a dead token, functions the token isn't allowed to call.

const fixtures = join(import.meta.dirname, 'fixtures', 'lms');
const load = (name) => JSON.parse(readFileSync(join(fixtures, `${name}.json`), 'utf8'));

export async function startFakeLms() {
  const state = {
    username: 'student',
    password: 'correct horse battery',
    token: 'fake-token-0123456789abcdef',
    tokenValid: true,
    siteInfo: load('site_info'),
    courses: load('courses_timeline'),
    assignments: load('assignments'),
    submissions: load('submission_status'),
    quizzes: load('quizzes'),
    attempts: load('quiz_attempts'),
    events: load('action_events').events,
    // Every request: { path, wsfunction, params } (params without the token or password).
    calls: [],
    // Raw request bodies, to check where the password and token were sent.
    bodies: [],
  };
  const allowed = () => new Set(state.siteInfo.functions.map((f) => f.name));
  const list = (params, name) => Object.keys(params).filter((k) => k.startsWith(`${name}[`)).map((k) => Number(params[k]));

  const handlers = {
    core_webservice_get_site_info: () => state.siteInfo,
    core_course_get_enrolled_courses_by_timeline_classification: () => state.courses,
    core_enrol_get_users_courses: () => state.courses.courses,
    core_calendar_get_action_events_by_timesort: (p) => {
      const limit = Number(p.limitnum ?? 50);
      let events = state.events.filter((e) => e.timesort >= Number(p.timesortfrom ?? 0)).sort((a, b) => a.timesort - b.timesort || a.id - b.id);
      if (p.aftereventid) events = events.slice(events.findIndex((e) => e.id === Number(p.aftereventid)) + 1);
      const page = events.slice(0, limit);
      return { events: page, firstid: page[0]?.id ?? 0, lastid: page[page.length - 1]?.id ?? 0 };
    },
    mod_assign_get_assignments: (p) => {
      const ids = list(p, 'courseids');
      return { ...state.assignments, courses: state.assignments.courses.filter((c) => ids.includes(c.id)) };
    },
    // Like the real LMS, an id that isn't an assignment id is an error.
    mod_assign_get_submission_status: (p) =>
      state.submissions[p.assignid] ?? { exception: 'dml_missing_record_exception', errorcode: 'invalidrecord', message: "Can't find data record in database table assign." },
    mod_quiz_get_quizzes_by_courses: (p) => {
      const ids = list(p, 'courseids');
      return { ...state.quizzes, quizzes: state.quizzes.quizzes.filter((q) => ids.includes(q.course)) };
    },
    mod_quiz_get_user_attempts: (p) => state.attempts[p.quizid] ?? { attempts: [], warnings: [] },
  };

  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    state.bodies.push(raw);
    const url = new URL(req.url, 'http://lms.test');
    const params = Object.fromEntries(new URLSearchParams(raw));
    const send = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/login/token.php') {
      state.calls.push({ path: url.pathname });
      if (params.username === state.username && params.password === state.password && params.service === 'moodle_mobile_app') {
        state.tokenValid = true;
        return send({ token: state.token, privatetoken: 'private-should-be-ignored' });
      }
      return send({ error: 'Invalid login, please try again', errorcode: 'invalidlogin', stacktrace: null, debuginfo: null });
    }

    if (url.pathname === '/webservice/rest/server.php') {
      const wsfunction = url.searchParams.get('wsfunction');
      const { wstoken, ...rest } = params;
      state.calls.push({ path: url.pathname, wsfunction, params: rest });
      if (wstoken !== state.token || !state.tokenValid) return send({ exception: 'moodle_exception', errorcode: 'invalidtoken', message: 'Invalid token - token not found' });
      if (!allowed().has(wsfunction) || !handlers[wsfunction]) {
        return send({ exception: 'webservice_access_exception', errorcode: 'accessexception', message: 'Access control exception' });
      }
      return send(handlers[wsfunction](rest));
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    /** Calls of one web-service function. */
    callsOf: (fn) => state.calls.filter((c) => c.wsfunction === fn),
    /** Lets the token call only these functions (site info is always allowed). */
    allowOnly(names) {
      state.siteInfo = { ...state.siteInfo, functions: ['core_webservice_get_site_info', ...names].map((name) => ({ name, version: '1' })) };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
