import { get, post, put } from '../api.js';
import { Icon } from '../components/Icon.jsx';
import { TaskRow } from '../components/TaskRow.jsx';
import { AddRow, LoadError, Loading, MoveButtons, moved } from '../components/ui.jsx';
import { addDays, dayLabel, hourIST, longDay, todayIST } from '../dates.js';
import { attempt, go, useLoad } from '../hooks.js';

/** Planning a day. Opens on tomorrow in the evening (from 6 PM), otherwise today. */
export function Plan({ day: requested }) {
  const today = todayIST();
  const day = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : hourIST() >= 18 ? addDays(today, 1) : today;
  const past = day < today;
  const { data, error, loading, reload, setData } = useLoad(() => get(`/days/${day}`), [day]);

  const add = async (title) => {
    const res = await attempt(post(`/days/${day}/tasks`, { title }));
    if (res) setData(res);
    return Boolean(res);
  };
  const reorder = async (index, direction) => {
    const taskIds = moved(data.tasks.map((t) => t.id), index, direction);
    const res = await attempt(put(`/days/${day}/order`, { taskIds }));
    if (res) setData(res);
  };

  return (
    <>
      <h1 class="page-title">Plan</h1>
      <p class="page-sub">Add what you want to get done. Unticked tasks go to Unfinished at midnight.</p>

      <div class="switcher">
        <button type="button" class="icon-btn" aria-label="Previous day" onClick={() => go(`/plan/${addDays(day, -1)}`)}>
          <Icon name="left" />
        </button>
        <div class="switcher-label">
          <div>{dayLabel(day, today)}</div>
          <div class="small muted">{longDay(day)}</div>
        </div>
        <button type="button" class="icon-btn" aria-label="Next day" onClick={() => go(`/plan/${addDays(day, 1)}`)}>
          <Icon name="right" />
        </button>
      </div>
      <div class="btn-row" style={{ justifyContent: 'center', marginBottom: '16px' }}>
        <button type="button" class="btn btn-small" disabled={day === today} onClick={() => go(`/plan/${today}`)}>
          Today
        </button>
        <button type="button" class="btn btn-small" disabled={day === addDays(today, 1)} onClick={() => go(`/plan/${addDays(today, 1)}`)}>
          Tomorrow
        </button>
        <input
          type="date"
          class="input"
          style={{ width: 'auto', minHeight: '32px', padding: '2px 8px' }}
          aria-label="Pick a day"
          value={day}
          onChange={(e) => e.currentTarget.value && go(`/plan/${e.currentTarget.value}`)}
        />
      </div>

      {!data ? (
        error ? (
          <LoadError error={error} retry={reload} />
        ) : (
          <Loading />
        )
      ) : (
        <div class="card" aria-busy={loading}>
          <ul class="list">
            {data.tasks.map((task, i) => (
              <TaskRow key={task.id} task={task} onChanged={reload} readOnly={past}>
                {!past && <MoveButtons index={i} count={data.tasks.length} label={task.title} onMove={(d) => reorder(i, d)} />}
              </TaskRow>
            ))}
            {data.tasks.length === 0 && <li class="empty">{past ? 'Nothing was left on this day.' : 'Nothing planned yet.'}</li>}
          </ul>
          {!past && <AddRow placeholder={`Add a task for ${dayLabel(day, today).toLowerCase()}`} onAdd={add} />}
        </div>
      )}

      <p class="small muted" style={{ marginTop: '14px' }}>
        <Icon name="repeat" size={14} /> Tasks that repeat every week are set up in <a href="#/more">More → Repeating tasks</a>.
      </p>
    </>
  );
}
