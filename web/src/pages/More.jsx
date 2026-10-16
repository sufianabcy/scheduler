import { useState } from 'preact/hooks';
import { del, get, patch, post } from '../api.js';
import { Icon } from '../components/Icon.jsx';
import { InlineEdit, LoadError, Loading } from '../components/ui.jsx';
import { attempt, useLoad } from '../hooks.js';
import { currentTheme, setTheme } from '../theme.js';

const DAY_NAMES = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

function WeekdayChips({ value, onChange, weekdays }) {
  const toggle = (day) => {
    const next = value.includes(day) ? value.filter((d) => d !== day) : weekdays.filter((d) => d === day || value.includes(d));
    if (next.length > 0) onChange(next);
  };
  return (
    <div class="chips" role="group" aria-label="Weekdays">
      {weekdays.map((day) => (
        <button key={day} type="button" class="chip" aria-pressed={value.includes(day)} onClick={() => toggle(day)}>
          {DAY_NAMES[day]}
        </button>
      ))}
    </div>
  );
}

function Repeating() {
  const { data, error, reload } = useLoad(() => get('/repeating'), []);
  const [title, setTitle] = useState('');
  const [days, setDays] = useState(['mon', 'tue', 'wed', 'thu', 'fri']);

  if (!data) return error ? <LoadError error={error} retry={reload} /> : <Loading />;

  const run = async (promise) => {
    if ((await attempt(promise)) !== undefined) reload();
  };
  const add = async (e) => {
    e.preventDefault();
    if (await attempt(post('/repeating', { title: title.trim(), weekdays: days }))) {
      setTitle('');
      reload();
    }
  };

  return (
    <div class="card">
      <ul class="list">
        {data.rules.map((rule) => (
          <li key={rule.id} class={`row${rule.active ? '' : ' is-locked'}`} style={{ flexWrap: 'wrap', paddingTop: '12px', paddingBottom: '12px' }}>
            <div class="row-main">
              <InlineEdit value={rule.title} label="repeating task" onSave={(t) => run(patch(`/repeating/${rule.id}`, { title: t }))} />
              {!rule.active && <div class="row-meta">Paused</div>}
            </div>
            <button type="button" class="btn btn-small" onClick={() => run(patch(`/repeating/${rule.id}`, { active: !rule.active }))}>
              {rule.active ? 'Pause' : 'Resume'}
            </button>
            <button
              type="button"
              class="icon-btn"
              aria-label={`Delete ${rule.title}`}
              onClick={() => confirm(`Stop repeating "${rule.title}"?`) && run(del(`/repeating/${rule.id}`))}
            >
              <Icon name="trash" size={18} />
            </button>
            <div style={{ width: '100%', marginTop: '8px' }}>
              <WeekdayChips value={rule.weekdays} weekdays={data.weekdays} onChange={(weekdays) => run(patch(`/repeating/${rule.id}`, { weekdays }))} />
            </div>
          </li>
        ))}
        {data.rules.length === 0 && <li class="empty">No repeating tasks yet, e.g. "Gym" every weekday.</li>}
      </ul>
      <form class="card-pad" style={{ borderTop: '1px solid var(--border)' }} onSubmit={add}>
        <div class="field">
          <label for="repeat-title">New repeating task</label>
          <input id="repeat-title" class="input" maxLength={200} value={title} placeholder="Gym" onInput={(e) => setTitle(e.currentTarget.value)} />
        </div>
        <div class="field">
          <WeekdayChips value={days} weekdays={data.weekdays} onChange={setDays} />
        </div>
        <button class="btn btn-primary btn-small" type="submit" disabled={!title.trim()}>
          <Icon name="plus" size={16} /> Add
        </button>
      </form>
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
    <div class="card">
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

export function More({ user, onLogout }) {
  const [theme, setThemeState] = useState(currentTheme());
  const toggleTheme = () => setThemeState(setTheme(theme === 'dark' ? 'light' : 'dark'));

  return (
    <>
      <h1 class="page-title">More</h1>
      <p class="page-sub">Logged in as {user.email}</p>

      <section class="section">
        <h2 class="section-title" style={{ marginBottom: '10px' }}>
          Repeating tasks
        </h2>
        <Repeating />
      </section>

      <section class="section">
        <h2 class="section-title" style={{ marginBottom: '10px' }}>
          Project templates
        </h2>
        <Templates />
      </section>

      <section class="section">
        <h2 class="section-title" style={{ marginBottom: '10px' }}>
          This device
        </h2>
        <div class="card">
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
