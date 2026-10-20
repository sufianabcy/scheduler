import { useEffect, useState } from 'preact/hooks';
import { get, patch, post } from '../api.js';
import { Icon } from '../components/Icon.jsx';
import { LoadError, Loading, PageHeader } from '../components/ui.jsx';
import { dueLabel } from '../dates.js';
import { attempt, useLoad } from '../hooks.js';
import { ago } from '../mailFormat.js';
import { toast } from '../toast.js';

const STATUS_LABEL = { upcoming: 'Upcoming', overdue: 'Overdue', missed: 'Missed', done: 'Done' };

function NotSetUp() {
  return (
    <div class="card card-pad">
      <p>The LMS isn't switched on for this server yet.</p>
      <p class="small muted">It needs LMS_TOKEN_KEY in the server settings. See "LMS setup" in the deploy guide.</p>
    </div>
  );
}

/**
 * Username and password for the LMS. They go to the server once, which swaps them for an LMS token; only the
 * token is kept. The password field is cleared straight after.
 */
function ConnectForm({ reconnect, onConnected }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    const res = await attempt(post('/lms/connect', { username: username.trim(), password }));
    setPassword('');
    setBusy(false);
    if (res) {
      toast('LMS connected. Fetching your deadlines…');
      onConnected(res);
    }
  };

  return (
    <form class="card card-pad" onSubmit={submit}>
      {reconnect && (
        <p class="prio-text prio-1" style={{ marginTop: 0 }}>
          The LMS sign-in stopped working. Sign in again to keep your deadlines up to date.
        </p>
      )}
      <div class="field">
        <label for="lms-username">LMS username</label>
        <input id="lms-username" class="input" autocomplete="username" autocapitalize="off" spellcheck={false} maxLength={200} value={username} onInput={(e) => setUsername(e.currentTarget.value)} />
      </div>
      <div class="field">
        <label for="lms-password">LMS password</label>
        <input id="lms-password" class="input" type="password" autocomplete="current-password" maxLength={200} value={password} onInput={(e) => setPassword(e.currentTarget.value)} />
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" type="submit" disabled={busy || !username.trim() || !password}>
          {busy ? 'Connecting…' : reconnect ? 'Reconnect LMS' : 'Connect LMS'}
        </button>
      </div>
      <p class="small muted">
        Your password goes to lms.kluniversity.in once, to get a sign-in token like the Moodle app does. Only that token is
        saved, encrypted. The password is never stored.
      </p>
    </form>
  );
}

/** A course: how much is open or missed, the project it belongs to, and whether to show it at all. */
function CourseRow({ course, projects, onChanged }) {
  const change = async (body) => {
    if (await attempt(patch(`/lms/courses/${course.id}`, body))) onChanged();
  };
  const pickProject = async (value) => {
    if (value === 'new') {
      const project = await attempt(post('/projects', { title: course.name.slice(0, 200) }));
      if (project) await change({ projectId: project.id });
      return;
    }
    await change({ projectId: value ? Number(value) : null });
  };
  const counts = [course.open && `${course.open} open`, course.missed && `${course.missed} missed`].filter(Boolean).join(' · ');

  return (
    <li class={`row${course.hidden ? ' is-locked' : ''}`} style={{ flexWrap: 'wrap' }}>
      <div class="row-main">
        <div class="row-title">{course.name}</div>
        <div class="row-meta meta-line">
          {course.shortName && <span>{course.shortName}</span>}
          <span>{course.hidden ? 'hidden' : counts || 'nothing due'}</span>
        </div>
      </div>
      <select class="select" style={{ width: 'auto', maxWidth: '45%' }} aria-label={`Project for ${course.name}`} value={course.projectId ?? ''} onChange={(e) => pickProject(e.currentTarget.value)}>
        <option value="">No project</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title}
          </option>
        ))}
        <option value="new">+ New project</option>
      </select>
      <label class="toggle-row small">
        <input type="checkbox" checked={!course.hidden} onChange={(e) => change({ hidden: !e.currentTarget.checked })} /> Show
      </label>
    </li>
  );
}

/** One piece of LMS work in a list: title, course, when it's due, and a link to it. Also used on Today. */
export function ItemRow({ item }) {
  return (
    <li class="row">
      <div class="row-main">
        <div class="row-title">{item.title}</div>
        <div class="row-meta meta-line">
          <span>{item.courseShort ?? item.course}</span>
          {item.dueAt && (
            <span class={item.status === 'overdue' || item.status === 'missed' ? 'prio-text prio-1' : undefined}>
              {item.status === 'upcoming' ? 'Due' : 'Was due'} {dueLabel(item.dueAt)}
            </span>
          )}
          {item.status === 'overdue' && item.cutoffAt && <span>accepted until {dueLabel(item.cutoffAt)}</span>}
          {item.grade && <span>Grade {item.grade}</span>}
          {item.url && (
            <a href={item.url} target="_blank" rel="noopener noreferrer">
              <Icon name="external" size={13} /> Open in LMS
            </a>
          )}
        </div>
      </div>
      {item.status !== 'upcoming' && <span class={`badge${item.status === 'done' ? '' : ' badge-red'}`}>{STATUS_LABEL[item.status]}</span>}
    </li>
  );
}

function Semester({ status, onSaved }) {
  const save = async (value) => {
    const res = await attempt(patch('/lms/settings', { semesterStart: value || null }));
    if (res) {
      toast('Saved. The next sync looks back to then.');
      onSaved(res);
    }
  };
  return (
    <li class="row">
      <div class="row-main">
        <div>Semester start</div>
        <div class="row-meta">Missed work is listed from this day on. Empty: the last {status.lookbackDays} days.</div>
      </div>
      <input type="date" class="input" style={{ width: 'auto' }} aria-label="Semester start" value={status.semesterStart ?? ''} onChange={(e) => save(e.currentTarget.value)} />
    </li>
  );
}

/** More → LMS: connect, sync, the semester start, courses, and what's coming up. */
export function Lms() {
  const { data: status, error, reload, setData } = useLoad(() => get('/lms/status'), []);
  const ready = status?.connected && status.status === 'ok';
  const lists = useLoad(() => (ready ? Promise.all([get('/lms/items?status=open'), get('/lms/courses'), get('/projects')]) : Promise.resolve(null)), [ready]);
  const [syncing, setSyncing] = useState(false);

  // The first sync runs in the background after connecting; refresh until it's done.
  useEffect(() => {
    if (!status?.syncing) return undefined;
    const timer = setTimeout(() => {
      reload();
      lists.reload();
    }, 3000);
    return () => clearTimeout(timer);
  }, [status]);

  if (!status) return error ? <LoadError error={error} retry={reload} /> : <Loading />;
  const refresh = () => {
    reload();
    lists.reload();
  };

  const syncNow = async () => {
    setSyncing(true);
    const res = await attempt(post('/lms/sync'));
    setSyncing(false);
    if (res) {
      setData(res);
      lists.reload();
      if (res.lastError) toast(res.lastError);
    }
  };
  const disconnect = async () => {
    if (!confirm('Disconnect the LMS? Its synced deadlines are removed from the app.')) return;
    if ((await attempt(post('/lms/disconnect'))) !== undefined) reload();
  };

  const header = <PageHeader title="LMS" sub="KL University LMS: deadlines, overdue and missed work" />;
  if (!status.enabled) {
    return (
      <>
        {header}
        <NotSetUp />
      </>
    );
  }
  if (!ready) {
    return (
      <>
        {header}
        <ConnectForm reconnect={status.status === 'needs_reconnect'} onConnected={setData} />
      </>
    );
  }

  const [items, courses, projects] = lists.data ? [lists.data[0].items, lists.data[1].courses, lists.data[2].projects] : [[], [], []];
  const c = status.counts;

  return (
    <>
      {header}
      <section class="section card">
        <ul class="list">
          <li class="row" style={{ flexWrap: 'wrap' }}>
            <div class="row-main">
              <div>Connected</div>
              <div class="row-meta meta-line">
                {status.syncing || syncing ? (
                  <span>Syncing…</span>
                ) : status.lastError ? (
                  <span class="prio-text prio-2">Last sync failed: {status.lastError}</span>
                ) : (
                  <span>Synced {ago(status.lastSyncedAt)}</span>
                )}
                <span>every 2 h and when you open the app</span>
              </div>
            </div>
            <button type="button" class="btn btn-small" disabled={syncing || status.syncing} onClick={syncNow}>
              <Icon name="refresh" size={16} /> Sync now
            </button>
          </li>
          <li class="row">
            <div class="row-main meta-line">
              <span>{c.upcoming} upcoming</span>
              <span class={c.overdue ? 'prio-text prio-1' : undefined}>{c.overdue} overdue</span>
              <a href="#/lms/missed">{c.missed} missed</a>
              <span>{c.done} done</span>
            </div>
          </li>
          {status.missingFunctions.length > 0 && (
            <li class="row">
              <div class="row-main row-meta">
                The LMS doesn't let the app use {status.missingFunctions.join(', ')}. Deadlines still come from the LMS
                calendar, but some details (like whether something was submitted) may be missing.
              </div>
            </li>
          )}
          <Semester
            status={status}
            onSaved={(res) => {
              setData(res);
              lists.reload();
            }}
          />
        </ul>
      </section>

      <section class="section card">
        <div class="section-head">
          <h2 class="section-title">Coming up</h2>
          <a class="section-link" href="#/lms/missed">
            Missed
          </a>
        </div>
        <ul class="list">
          {items.map((item) => (
            <ItemRow key={item.id} item={item} />
          ))}
          {items.length === 0 && <li class="empty">{lists.loading || status.syncing ? 'Loading…' : 'Nothing due. Nice.'}</li>}
        </ul>
      </section>

      <section class="section card">
        <div class="section-head">
          <h2 class="section-title">Courses</h2>
        </div>
        <ul class="list">
          {courses.map((course) => (
            <CourseRow key={course.id} course={course} projects={projects} onChanged={refresh} />
          ))}
          {courses.length === 0 && <li class="empty">{status.syncing ? 'Loading…' : 'No courses yet.'}</li>}
        </ul>
        <p class="small muted" style={{ padding: '0 14px' }}>
          Hiding a course takes its deadlines off your plan.
        </p>
      </section>

      <div class="section">
        <button type="button" class="btn btn-ghost btn-small btn-danger" onClick={disconnect}>
          Disconnect LMS
        </button>
      </div>
    </>
  );
}

/** Work whose deadline (and cut-off) passed without a submission, by course. */
export function LmsMissed() {
  const { data, error, reload } = useLoad(() => get('/lms/items?status=missed'), []);
  if (!data) return error ? <LoadError error={error} retry={reload} /> : <Loading />;

  const byCourse = new Map();
  for (const item of data.items) {
    if (!byCourse.has(item.courseId)) byCourse.set(item.courseId, { name: item.course, items: [] });
    byCourse.get(item.courseId).items.push(item);
  }

  return (
    <>
      <PageHeader title="Missed" sub={`${data.items.length} missed on the LMS this semester`} />
      {byCourse.size === 0 && <div class="card empty">Nothing missed. Keep it that way.</div>}
      {[...byCourse].map(([id, course]) => (
        <section key={id} class="section card">
          <div class="section-head">
            <h2 class="section-title">
              {course.name} <span class="badge badge-red">{course.items.length}</span>
            </h2>
          </div>
          <ul class="list">
            {course.items.map((item) => (
              <ItemRow key={item.id} item={item} />
            ))}
          </ul>
        </section>
      ))}
      <div class="section">
        <a class="btn btn-small" href="#/lms">
          <Icon name="left" size={16} /> LMS
        </a>
      </div>
    </>
  );
}
