import { useState } from 'preact/hooks';
import { del, get, patch, post } from '../api.js';
import { Icon } from '../components/Icon.jsx';
import { TaskRow } from '../components/TaskRow.jsx';
import { AddRow, Check, LoadError, Loading, Progress } from '../components/ui.jsx';
import { addDays, dayLabel, hourIST, longDay } from '../dates.js';
import { attempt, useLoad } from '../hooks.js';

function greeting() {
  const h = hourIST();
  if (h < 5) return 'Late night';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

/** A monthly-goal task with a date of today (or earlier). Only the goal's current task can be finished. */
function GoalTaskRow({ item, onChanged }) {
  const locked = item.state === 'locked';
  const finish = async () => {
    if (await attempt(post(`/goals/${item.goalId}/tasks/${item.taskId}/finish`))) onChanged();
  };
  return (
    <li class={`row${locked ? ' is-locked' : ''}`}>
      <Check checked={false} disabled={locked} label={`Done: ${item.title}`} onChange={finish} />
      <div class="row-main">
        <div class="row-title">{item.title}</div>
        <div class="row-meta">
          <a href={`#/goals/${item.goalId}`}>{item.goalTitle}</a>
          {locked && ' · finish the earlier tasks first'}
        </div>
      </div>
      {locked && <Icon name="lock" size={18} />}
    </li>
  );
}

function UnfinishedRow({ task, today, onChanged }) {
  const [moving, setMoving] = useState(false);
  const change = async (body) => {
    if (await attempt(patch(`/tasks/${task.id}`, body))) onChanged();
  };
  const remove = async () => {
    if (!confirm(`Delete "${task.title}"?`)) return;
    if ((await attempt(del(`/tasks/${task.id}`))) !== undefined) onChanged();
  };

  return (
    <li class="row" style={{ flexWrap: 'wrap' }}>
      <Check checked={false} label={`Done: ${task.title}`} onChange={() => change({ done: true })} />
      <div class="row-main">
        <div class="row-title">{task.title}</div>
        <div class="row-meta">from {dayLabel(task.day, today)}</div>
      </div>
      <button type="button" class="icon-btn" aria-label={`Move ${task.title} to a day`} aria-expanded={moving} onClick={() => setMoving(!moving)}>
        <Icon name="move" size={18} />
      </button>
      <button type="button" class="icon-btn" aria-label={`Delete ${task.title}`} onClick={remove}>
        <Icon name="trash" size={18} />
      </button>
      {moving && (
        <div class="btn-row" style={{ width: '100%', paddingLeft: '40px' }}>
          <button type="button" class="btn btn-small" onClick={() => change({ day: today })}>
            Today
          </button>
          <button type="button" class="btn btn-small" onClick={() => change({ day: addDays(today, 1) })}>
            Tomorrow
          </button>
          <input
            type="date"
            class="input btn-small"
            style={{ width: 'auto', minHeight: '32px', padding: '2px 8px' }}
            min={today}
            aria-label="Move to date"
            onChange={(e) => e.currentTarget.value && change({ day: e.currentTarget.value })}
          />
        </div>
      )}
    </li>
  );
}

export function GoalCard({ goal }) {
  return (
    <a class="card goal-card" href={`#/goals/${goal.id}`}>
      <h3>{goal.title}</h3>
      <Progress value={goal.progress} label={`${goal.title} progress`} />
      <div class="now">
        {goal.currentTask ? (
          <>
            Now: <strong>{goal.currentTask.title}</strong>
          </>
        ) : goal.done ? (
          'All tasks done'
        ) : (
          'No tasks yet'
        )}
        {goal.carriedFrom && <span class="badge" style={{ marginLeft: '6px' }}>carried over</span>}
      </div>
    </a>
  );
}

export function ProjectCard({ project }) {
  return (
    <a class="card goal-card" href={`#/projects/${project.id}`}>
      <h3>{project.title}</h3>
      <Progress value={project.progress} label={`${project.title} progress`} />
      <div class="now">
        {project.currentStep ? (
          <>
            Step {project.stepsDone + 1} of {project.stepsTotal}: <strong>{project.currentStep.title}</strong>
          </>
        ) : project.done ? (
          'Finished'
        ) : (
          'No steps yet'
        )}
      </div>
    </a>
  );
}

export function Today() {
  const { data, error, loading, reload } = useLoad(() => get('/today'), []);

  if (!data) return error ? <LoadError error={error} retry={reload} /> : <Loading />;

  const openCount = data.tasks.filter((t) => t.status === 'open').length + data.goalTasksDue.length;
  const activeProjects = data.projects.filter((p) => !p.done);
  const add = async (title) => {
    const ok = await attempt(post(`/days/${data.day}/tasks`, { title }));
    if (ok) reload();
    return Boolean(ok);
  };

  return (
    <>
      <h1 class="page-title">{greeting()}</h1>
      <p class="page-sub">
        {longDay(data.day)} · {openCount === 0 ? 'nothing left today' : `${openCount} to do`}
        {loading && ' · updating…'}
      </p>

      <section class="section" aria-labelledby="today-title">
        <div class="section-head">
          <h2 class="section-title" id="today-title">
            Today
          </h2>
          <a class="btn btn-ghost btn-small" href={`#/plan/${addDays(data.day, 1)}`}>
            Plan tomorrow
          </a>
        </div>
        <div class="card">
          <ul class="list">
            {data.goalTasksDue.map((item) => (
              <GoalTaskRow key={`g${item.taskId}`} item={item} onChanged={reload} />
            ))}
            {data.tasks.map((task) => (
              <TaskRow key={task.id} task={task} onChanged={reload} />
            ))}
            {data.tasks.length === 0 && data.goalTasksDue.length === 0 && (
              <li class="empty">Nothing planned yet. Add your first task below.</li>
            )}
          </ul>
          <AddRow placeholder="Add a task for today" onAdd={add} />
        </div>
      </section>

      {data.unfinished.length > 0 && (
        <section class="section" aria-labelledby="unfinished-title">
          <div class="section-head">
            <h2 class="section-title" id="unfinished-title">
              Unfinished <span class="badge badge-red">{data.unfinished.length}</span>
            </h2>
          </div>
          <div class="card">
            <ul class="list">
              {data.unfinished.map((task) => (
                <UnfinishedRow key={task.id} task={task} today={data.day} onChanged={reload} />
              ))}
            </ul>
          </div>
        </section>
      )}

      <section class="section" aria-labelledby="goals-title">
        <div class="section-head">
          <h2 class="section-title" id="goals-title">
            Monthly goals
          </h2>
          <a class="btn btn-ghost btn-small" href="#/goals">
            All goals
          </a>
        </div>
        {data.goals.length === 0 ? (
          <div class="card empty">
            No goals for this month. <a href="#/goals">Add one</a>
          </div>
        ) : (
          <div class="cards">
            {data.goals.map((goal) => (
              <GoalCard key={goal.id} goal={goal} />
            ))}
          </div>
        )}
      </section>

      <section class="section" aria-labelledby="projects-title">
        <div class="section-head">
          <h2 class="section-title" id="projects-title">
            Projects
          </h2>
          <a class="btn btn-ghost btn-small" href="#/projects">
            All projects
          </a>
        </div>
        {activeProjects.length === 0 ? (
          <div class="card empty">
            No active projects. <a href="#/projects">Start one</a>
          </div>
        ) : (
          <div class="cards">
            {activeProjects.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
