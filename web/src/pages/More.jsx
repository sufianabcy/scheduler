import { useEffect, useState } from 'preact/hooks';
import { del, get, patch, post } from '../api.js';
import { Icon } from '../components/Icon.jsx';
import { PriorityPicker, ReminderPicker, RepeatPicker } from '../components/TaskOptions.jsx';
import { LoadError, Loading, PageHeader } from '../components/ui.jsx';
import { formatTime } from '../dates.js';
import { attempt, useLoad } from '../hooks.js';
import { diagnose, disablePush, enablePush, ensurePush, onPushChange, pushProblem, pushState } from '../push.js';
import { describeRepeat, repeatBody, sameRepeat } from '../repeat.js';
import { toast } from '../toast.js';
import { currentTheme, setTheme } from '../theme.js';

/** A repeating task in More: tap its name to change the title, repeat or reminder. */
function RuleRow({ rule, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(rule.title);
  const [repeat, setRepeat] = useState(rule);
  const [remindAt, setRemindAt] = useState(rule.remindAt);
  const [priority, setPriority] = useState(rule.priority);

  const run = async (promise) => {
    if ((await attempt(promise)) !== undefined) onChanged();
  };
  const save = async (e) => {
    e.preventDefault();
    const body = {};
    if (title.trim() && title.trim() !== rule.title) body.title = title.trim();
    if (remindAt !== rule.remindAt) body.remindAt = remindAt;
    if (priority !== rule.priority) body.priority = priority;
    if (repeat && !sameRepeat(repeat, rule)) body.repeat = repeatBody(repeat);
    if (Object.keys(body).length === 0) return setEditing(false);
    if (await attempt(patch(`/repeating/${rule.id}`, body))) {
      setEditing(false);
      onChanged();
    }
  };

  return (
    <li class={`row${rule.active ? '' : ' is-locked'}`} style={{ flexWrap: 'wrap' }}>
      <div class="row-main">
        <button type="button" class="title-button row-title" aria-expanded={editing} onClick={() => setEditing(!editing)}>
          {rule.title}
        </button>
        <div class="row-meta meta-line">
          {rule.priority && (
            <span class={`prio-text prio-${rule.priority}`}>
              <Icon name="flag" size={13} /> P{rule.priority}
            </span>
          )}
          <span>
            <Icon name="repeat" size={13} /> {describeRepeat(rule, rule.startDay)}
          </span>
          {rule.remindAt && (
            <span>
              <Icon name="bell" size={13} /> {formatTime(rule.remindAt)}
            </span>
          )}
          {!rule.active && <span>paused</span>}
        </div>
      </div>
      <button type="button" class="btn btn-small" onClick={() => run(patch(`/repeating/${rule.id}`, { active: !rule.active }))}>
        {rule.active ? 'Pause' : 'Resume'}
      </button>
      <button
        type="button"
        class="icon-btn"
        aria-label={`Delete ${rule.title}`}
        onClick={() => confirm(`Stop repeating "${rule.title}"? Past days keep their copies.`) && run(del(`/repeating/${rule.id}`))}
      >
        <Icon name="trash" size={18} />
      </button>
      {editing && (
        <form class="editor" onSubmit={save}>
          <div class="field">
            <label for={`rule-${rule.id}`}>Task</label>
            <input id={`rule-${rule.id}`} class="input" maxLength={200} value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
          </div>
          <PriorityPicker value={priority} onChange={setPriority} />
          <RepeatPicker value={repeat} day={rule.startDay} onChange={(r) => r && setRepeat(r)} />
          <ReminderPicker value={remindAt} onChange={setRemindAt} />
          <div class="btn-row">
            <button class="btn btn-primary btn-small" type="submit" disabled={!title.trim()}>
              Save
            </button>
            <button class="btn btn-ghost btn-small" type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

function Repeating() {
  const { data, error, reload } = useLoad(() => get('/repeating'), []);
  if (!data) return error ? <LoadError error={error} retry={reload} /> : <Loading />;

  return (
    <div>
      <ul class="list">
        {data.rules.map((rule) => (
          <RuleRow key={rule.id} rule={rule} onChanged={reload} />
        ))}
        {data.rules.length === 0 && (
          <li class="empty">
            No repeating tasks yet. When adding a task, tap the <Icon name="bell" size={14} /> to make it repeat.
          </li>
        )}
      </ul>
    </div>
  );
}

function Templates() {
  const { data, error, reload } = useLoad(() => get('/templates'), []);
  if (!data) return error ? <LoadError error={error} retry={reload} /> : <Loading />;

  const remove = async (t) => {
    if (!confirm(`Delete the template "${t.name}"? Projects made from it are not affected.`)) return;
    if ((await attempt(del(`/templates/${t.id}`))) !== undefined) reload();
  };

  return (
    <div>
      <ul class="list">
        {data.templates.map((t) => (
          <li key={t.id} class="row">
            <div class="row-main">
              <div class="row-title">{t.name}</div>
              <div class="row-meta">{t.stepsTotal} steps</div>
            </div>
            <button type="button" class="icon-btn" aria-label={`Delete template ${t.name}`} onClick={() => remove(t)}>
              <Icon name="trash" size={18} />
            </button>
          </li>
        ))}
        {data.templates.length === 0 && <li class="empty">Save a project's steps as a template from the project's page.</li>}
      </ul>
    </div>
  );
}

const pushText = (state) => pushProblem(state) ?? { off: 'Off on this device.', on: 'On for this device.' }[state];

/** Each step notifications need on this device, ticked or crossed, to find what's missing. */
function DeviceCheck() {
  const [steps, setSteps] = useState(null);
  const run = () => diagnose().then(setSteps, (err) => toast(err.message));
  if (!steps) {
    return (
      <button type="button" class="link-button small" onClick={run}>
        Check this device
      </button>
    );
  }
  return (
    <ul class="list small" style={{ width: '100%' }}>
      {steps.map((s) => (
        <li key={s.label} class="meta-line" style={{ padding: '3px 0' }}>
          <span class={s.ok ? 'prio-text prio-3' : 'prio-text prio-1'}>{s.ok ? '✓' : '✗'}</span> {s.label}
        </li>
      ))}
      <li style={{ padding: '6px 0 0' }}>
        <button type="button" class="link-button small" onClick={run}>
          Check again
        </button>
      </li>
    </ul>
  );
}

/**
 * When the two daily notifications come, or whether they come at all. Saved for your account.
 * Switching one on asks this device for notification permission if it doesn't have it yet.
 */
function NotificationTimes({ onPushChange }) {
  const { data, error, reload, setData } = useLoad(() => get('/settings/notifications'), []);
  if (!data) return error ? <li class="row muted">{error.message}</li> : null;

  const save = async (changes) => {
    const res = await attempt(patch('/settings/notifications', changes));
    if (res) setData(res);
    else reload();
  };
  const switchOn = async (key, on) => {
    // Ask for permission first: browsers only show the prompt right after a tap.
    if (on) {
      try {
        const before = 'Notification' in window ? Notification.permission : null;
        if ((await ensurePush()) === 'on' && before !== 'granted') toast('Notifications turned on for this device');
      } catch (err) {
        toast(err.message);
      }
      onPushChange();
    }
    await save({ [key]: { on } });
  };
  const rows = [
    { key: 'eveningReminder', label: 'Plan-tomorrow reminder', hint: 'Skipped if tomorrow already has tasks', min: '12:00', max: '23:59' },
    { key: 'morningSummary', label: "Today's plan", hint: "What's on today and what's unfinished", min: '00:00', max: '12:00' },
  ];

  return rows.map((r) => (
    <li key={r.key} class="row">
      <label class="toggle-row row-main">
        <input type="checkbox" checked={data[r.key].on} onChange={(e) => switchOn(r.key, e.currentTarget.checked)} />
        <span>
          {r.label}
          <div class="row-meta" style={{ fontWeight: 400 }}>
            {r.hint}
          </div>
        </span>
      </label>
      <input
        type="time"
        class="input"
        style={{ width: 'auto' }}
        aria-label={`${r.label} time`}
        min={r.min}
        max={r.max}
        disabled={!data[r.key].on}
        value={data[r.key].time}
        onChange={(e) => e.currentTarget.value && save({ [r.key]: { time: e.currentTarget.value } })}
      />
    </li>
  ));
}

function Notifications() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => pushState().then(setState, () => setState('unsupported'));
  useEffect(() => {
    refresh();
    return onPushChange(refresh);
  }, []);

  const run = async (fn, done) => {
    setBusy(true);
    try {
      await fn();
      if (done) toast(done);
    } catch (err) {
      toast(err.message);
    }
    setBusy(false);
    refresh();
  };
  const test = () =>
    run(async () => {
      const r = await post('/push/test');
      if (r.failed === 0) toast('Test sent. It should appear in a few seconds. If not, check your system notification settings for Chrome.');
      else toast(`Sent to ${r.sent} device(s), ${r.failed} failed: ${r.errors?.[0]?.message ?? 'unknown error'}`);
    });

  return (
    <div>
      <ul class="list">
        <li class="row" style={{ flexWrap: 'wrap', paddingTop: '12px', paddingBottom: '12px' }}>
          <div class="row-main">
            <div>Reminders</div>
            <div class="row-meta">{state ? pushText(state) : 'Checking…'}</div>
          </div>
          {state === 'off' && (
            <button type="button" class="btn btn-primary btn-small" disabled={busy} onClick={() => run(enablePush, 'Notifications turned on')}>
              Turn on
            </button>
          )}
          {state === 'on' && (
            <span class="btn-row">
              <button type="button" class="btn btn-small" disabled={busy} onClick={test}>
                Send a test
              </button>
              <button type="button" class="btn btn-small btn-ghost" disabled={busy} onClick={() => run(disablePush, 'Notifications turned off')}>
                Turn off
              </button>
            </span>
          )}
          <div style={{ width: '100%', marginTop: '6px' }}>
            <DeviceCheck />
          </div>
        </li>
        <NotificationTimes onPushChange={refresh} />
        <li class="row">
          <div class="row-main row-meta">
            Task reminders are set on each task. Chrome must be allowed to show notifications by the system too:
            Mac: System Settings → Notifications → Google Chrome. Windows: Settings → System → Notifications →
            Google Chrome. Android: Settings → Apps → Chrome → Notifications. On a computer, Chrome has to be running.
          </div>
        </li>
      </ul>
    </div>
  );
}

export function More({ user, onLogout }) {
  const [theme, setThemeState] = useState(currentTheme());
  const toggleTheme = () => setThemeState(setTheme(theme === 'dark' ? 'light' : 'dark'));

  return (
    <>
      <PageHeader title="More" sub={`Logged in as ${user.email}`} />

      <section class="section card">
        <div class="section-head">
          <h2 class="section-title">Notifications</h2>
        </div>
        <Notifications />
      </section>

      <section class="section card">
        <div class="section-head">
          <h2 class="section-title">Mail accounts</h2>
        </div>
        <ul class="list">
          <li class="row">
            <div class="row-main">
              <div>Gmail and Outlook</div>
              <div class="row-meta">Connect, reconnect or disconnect the accounts shown in Mail.</div>
            </div>
            <a class="btn btn-small" href="#/mail/accounts">
              <Icon name="mail" size={16} /> Manage
            </a>
          </li>
        </ul>
      </section>

      <section class="section card">
        <div class="section-head">
          <h2 class="section-title">Repeating tasks</h2>
        </div>
        <Repeating />
      </section>

      <section class="section card">
        <div class="section-head">
          <h2 class="section-title">Project templates</h2>
        </div>
        <Templates />
      </section>

      <section class="section card">
        <div class="section-head">
          <h2 class="section-title">This device</h2>
        </div>
        <div>
          <ul class="list">
            <li class="row">
              <div class="row-main">Theme</div>
              <button type="button" class="btn btn-small" onClick={toggleTheme}>
                <Icon name={theme === 'dark' ? 'moon' : 'sun'} size={16} /> {theme === 'dark' ? 'Dark' : 'Light'}
              </button>
            </li>
            <li class="row">
              <div class="row-main">
                <div>Install as an app</div>
                <div class="row-meta">
                  Android: Chrome menu ⋮ → Add to Home screen. Mac: Chrome menu ⋮ → Cast, save and share → Install page as app.
                </div>
              </div>
            </li>
            <li class="row">
              <div class="row-main">Log out of this device</div>
              <button type="button" class="btn btn-small btn-danger" onClick={onLogout}>
                <Icon name="logout" size={16} /> Log out
              </button>
            </li>
          </ul>
        </div>
      </section>
    </>
  );
}
