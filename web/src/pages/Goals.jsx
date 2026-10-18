import { useState } from 'preact/hooks';
import { del, get, patch, post, put } from '../api.js';
import { Icon } from '../components/Icon.jsx';
import { AddRow, Check, InlineEdit, LoadError, Loading, MoveButtons, PageHeader, Progress, moved } from '../components/ui.jsx';
import { addMonths, dayLabel, monthLabel, todayIST } from '../dates.js';
import { attempt, go, useLoad } from '../hooks.js';
import { GoalCard } from './Today.jsx';

const lines = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function NewGoal({ month, onCreated }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [tasks, setTasks] = useState('');

  if (!open) {
    return (
      <button type="button" class="btn btn-primary" onClick={() => setOpen(true)}>
        <Icon name="plus" size={18} /> New goal
      </button>
    );
  }

  const submit = async (e) => {
    e.preventDefault();
    const goal = await attempt(post('/goals', { title, month, tasks: lines(tasks).map((t) => ({ title: t })) }));
    if (goal) onCreated(goal);
  };

  return (
    <form class="card card-pad" onSubmit={submit}>
      <div class="field">
        <label for="goal-title">Goal</label>
        <input id="goal-title" class="input" required maxLength={200} value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
      </div>
      <div class="field">
        <label for="goal-tasks">Tasks, in order (one per line)</label>
        <textarea
          id="goal-tasks"
          class="textarea"
          placeholder={'Read the docs\nBuild a small API\nDeploy it'}
          value={tasks}
          onInput={(e) => setTasks(e.currentTarget.value)}
        />
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" type="submit" disabled={!title.trim()}>
          Create goal
        </button>
        <button class="btn btn-ghost" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function GoalList({ month: requested }) {
  const thisMonth = todayIST().slice(0, 7);
  const month = requested && /^\d{4}-\d{2}$/.test(requested) ? requested : thisMonth;
  const { data, error, reload } = useLoad(() => get(`/goals?month=${month}`), [month]);

  return (
    <>
      <PageHeader title="Monthly goals" sub="Each goal's tasks open one at a time. Unfinished goals move to next month." />

      <div class="switcher">
        <button type="button" class="icon-btn" aria-label="Previous month" onClick={() => go(`/goals/m/${addMonths(month, -1)}`)}>
          <Icon name="left" />
        </button>
        <div class="switcher-label">
          {monthLabel(month)}
          {month === thisMonth && <div class="small muted">this month</div>}
        </div>
        <button type="button" class="icon-btn" aria-label="Next month" onClick={() => go(`/goals/m/${addMonths(month, 1)}`)}>
          <Icon name="right" />
        </button>
      </div>

      {!data ? (
        error ? (
          <LoadError error={error} retry={reload} />
        ) : (
          <Loading />
        )
      ) : (
        <>
          {data.goals.length === 0 ? (
            <div class="card empty">No goals for {monthLabel(month)} yet.</div>
          ) : (
            <div class="cards">
              {data.goals.map((goal) => (
                <GoalCard key={goal.id} goal={goal} />
              ))}
            </div>
          )}
          <div class="section">
            {month >= thisMonth && <NewGoal month={month} onCreated={(goal) => go(`/goals/${goal.id}`)} />}
          </div>
        </>
      )}
    </>
  );
}

function DueDate({ task, editable, onSet }) {
  const [editing, setEditing] = useState(false);
  const today = todayIST();
  if (editing) {
    return (
      <span class="btn-row" style={{ alignItems: 'center' }}>
        <input
          type="date"
          class="input"
          style={{ width: 'auto', minHeight: '30px', padding: '2px 8px' }}
          aria-label={`Date for ${task.title}`}
          value={task.dueDay ?? ''}
          onChange={(e) => {
            setEditing(false);
            onSet(e.currentTarget.value || null);
          }}
        />
        {task.dueDay && (
          <button
            type="button"
            class="btn btn-ghost btn-small"
            onClick={() => {
              setEditing(false);
              onSet(null);
            }}
          >
            No date
          </button>
        )}
      </span>
    );
  }
  if (!editable) return task.dueDay ? <span class="badge">{dayLabel(task.dueDay, today)}</span> : null;
  return (
    <button type="button" class="btn btn-ghost btn-small" style={{ padding: '0 6px', minHeight: '24px' }} onClick={() => setEditing(true)}>
      <Icon name="calendar" size={14} />
      {task.dueDay ? dayLabel(task.dueDay, today) : 'Add date'}
    </button>
  );
}

export function GoalDetail({ id }) {
  const { data: goal, error, reload, setData } = useLoad(() => get(`/goals/${id}`), [id]);
  const [newDay, setNewDay] = useState('');

  if (!goal) return error ? <LoadError error={error} retry={reload} /> : <Loading />;

  const base = `/goals/${goal.id}`;
  const apply = async (promise) => {
    const res = await attempt(promise);
    if (res) setData(res);
    return Boolean(res);
  };
  const open = goal.tasks.filter((t) => t.state !== 'done');
  const lastDone = goal.tasks.filter((t) => t.state === 'done').at(-1);

  const removeGoal = async () => {
    if (!confirm(`Delete the goal "${goal.title}" and all its tasks?`)) return;
    if ((await attempt(del(base))) !== undefined) go('/goals');
  };
  const removeTask = (task) => confirm(`Delete "${task.title}"?`) && apply(del(`${base}/tasks/${task.id}`));
  const reorder = (index, direction) => apply(put(`${base}/tasks/order`, { taskIds: moved(open.map((t) => t.id), index, direction) }));

  return (
    <>
      <a class="btn btn-ghost btn-small" href="#/goals" style={{ paddingLeft: 0 }}>
        <Icon name="left" size={16} /> Goals
      </a>
      <PageHeader
        title={<InlineEdit value={goal.title} label="goal title" onSave={(title) => apply(patch(base, { title }))} />}
        sub={`${monthLabel(goal.month)}${goal.carriedFrom ? ` · carried over from ${monthLabel(goal.carriedFrom)}` : ''} · ${goal.tasksDone} of ${goal.tasksTotal} done`}
      >
        <Progress value={goal.progress} label="Goal progress" />
      </PageHeader>

      <div class="card section">
        <ul class="list">
          {goal.tasks.map((task) => {
            const openIndex = open.indexOf(task);
            const isLastDone = task === lastDone;
            return (
              <li key={task.id} class={`row is-${task.state}`}>
                {task.state === 'locked' ? (
                  <span class="step-num" title="Locked until the earlier tasks are done">
                    <Icon name="lock" size={15} />
                  </span>
                ) : (
                  <Check
                    checked={task.state === 'done'}
                    disabled={task.state === 'done' && !isLastDone}
                    label={task.state === 'done' ? `Reopen: ${task.title}` : `Done: ${task.title}`}
                    onChange={(v) => apply(post(`${base}/tasks/${task.id}/${v ? 'finish' : 'reopen'}`))}
                  />
                )}
                <div class="row-main">
                  <InlineEdit value={task.title} label="task" onSave={(title) => apply(patch(`${base}/tasks/${task.id}`, { title }))} />
                  <div class="row-meta">
                    {task.state === 'current' && <span class="badge badge-red" style={{ marginRight: '6px' }}>Now</span>}
                    <DueDate
                      task={task}
                      editable={task.state !== 'done'}
                      onSet={(dueDay) => apply(patch(`${base}/tasks/${task.id}`, { dueDay }))}
                    />
                  </div>
                </div>
                {task.state !== 'done' && (
                  <>
                    <MoveButtons index={openIndex} count={open.length} label={task.title} onMove={(d) => reorder(openIndex, d)} />
                    <button type="button" class="icon-btn" aria-label={`Delete ${task.title}`} onClick={() => removeTask(task)}>
                      <Icon name="trash" size={18} />
                    </button>
                  </>
                )}
              </li>
            );
          })}
          {goal.tasks.length === 0 && <li class="empty">No tasks yet. Add them in the order you'll do them.</li>}
        </ul>
        <AddRow
          placeholder="Add a task"
          onAdd={async (title) => {
            const ok = await apply(post(`${base}/tasks`, { title, dueDay: newDay || null }));
            if (ok) setNewDay('');
            return ok;
          }}
          extra={
            <input
              type="date"
              class="input"
              style={{ width: '150px' }}
              aria-label="Optional date for the new task"
              value={newDay}
              onChange={(e) => setNewDay(e.currentTarget.value)}
            />
          }
        />
      </div>
      <p class="small muted">A task with a date also shows on that day's Today screen. If it isn't done, it moves to the next day.</p>

      <div class="section">
        <button type="button" class="btn btn-danger" onClick={removeGoal}>
          <Icon name="trash" size={18} /> Delete goal
        </button>
      </div>
    </>
  );
}
