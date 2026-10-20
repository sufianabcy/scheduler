import { useState } from 'preact/hooks';
import { del, get, patch, post } from '../api.js';
import { Icon } from '../components/Icon.jsx';
import { NotificationBanner } from '../components/NotificationBanner.jsx';
import { NewTask, TaskRow } from '../components/TaskRow.jsx';
import { Check, LoadError, Loading, PageHeader, Progress } from '../components/ui.jsx';
import { addDays, clockIST, dayLabel, fullDate, weekdayName } from '../dates.js';
import { attempt, useLoad, useNow } from '../hooks.js';
import { ago } from '../mailFormat.js';
import { ItemRow } from './Lms.jsx';

/**
 * The LMS on the home page, the one place LMS work shows outside the LMS tab (it isn't put on the plan as tasks):
 * counts, all overdue work, then the next few pieces coming up. Shown only when the LMS is switched on for this server.
 */
function LmsSection({ lms }) {
  if (!lms?.enabled) return null;
  const c = lms.counts;
  const overdue = lms.overdue ?? [];
  return (
    <section class={`section card${overdue.length ? ' lms-overdue' : ''}`} aria-labelledby="lms-title">
      <div class="section-head">
        <h2 class="section-title" id="lms-title">
          LMS
        </h2>
        <a class="section-link" href="#/lms">
          Open
        </a>
      </div>
      {!lms.connected ? (
        <div class="empty">
          See your KL University deadlines here. <a href="#/lms">Connect the LMS</a>
        </div>
      ) : (
        <>
          <div class="row meta-line">
            <span>{c.upcoming} coming up</span>
            <span class={c.overdue ? 'prio-text prio-1' : undefined}>{c.overdue} overdue</span>
            <a href="#/lms/missed" class={c.missed ? 'prio-text prio-1' : undefined}>
              {c.missed} missed
            </a>
          </div>
          <ul class="list">
            {[...overdue, ...lms.upcoming].map((item) => (
              <ItemRow key={item.id} item={item} />
            ))}
            {overdue.length + lms.upcoming.length === 0 && <li class="empty">Nothing due.</li>}
          </ul>
          <div class="small muted lms-synced">{lms.needsReconnect ? 'Not updating: reconnect the LMS' : `Synced ${ago(lms.lastSyncedAt)}`}</div>
        </>
      )}
    </section>
  );
}

/** A monthly-goal task with a date of today (or earlier). Only the goal's current task can be finished. */
function GoalTaskRow({ item, onChanged }) {
  const locked = item.state === 'locked';
  const finish = async () => {
    if (await attempt(post(`/goals/${item.goalId}/tasks/${item.taskId}/finish`))) onChanged();
  };
  return (
    <li class={`row task-row${locked ? ' is-locked' : ''}`}>
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
    <li class="row task-row" style={{ flexWrap: 'wrap' }}>
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

/** A goal's name, progress and current task. `plain` drops the card frame, for lists inside a section card. */
export function GoalCard({ goal, plain }) {
  return (
    <a class={`goal-card${plain ? ' goal-item' : ' card'}`} href={`#/goals/${goal.id}`}>
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

export function ProjectCard({ project, plain }) {
  return (
    <a class={`goal-card${plain ? ' goal-item' : ' card'}`} href={`#/projects/${project.id}`}>
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
  const now = useNow();
  const { data, error, loading, reload } = useLoad(() => get('/today'), []);

  if (!data) return error ? <LoadError error={error} retry={reload} /> : <Loading />;

  // Today's progress: ticked tasks out of everything on today's list (dated goal tasks count as not done yet).
  const doneCount = data.tasks.filter((t) => t.status === 'done').length;
  const total = data.tasks.length + data.goalTasksDue.length;
  const activeProjects = data.projects.filter((p) => !p.done);

  return (
    <>
      <PageHeader
        title={weekdayName(data.day)}
        aside={
          <span class="clock" aria-label="Time now">
            {clockIST(now)}
          </span>
        }
        sub={`${fullDate(data.day)} · ${total === 0 ? 'nothing planned yet' : `${doneCount} of ${total} done`}${loading ? ' · updating…' : ''}`}
      >
        {total > 0 && <Progress value={Math.floor((doneCount / total) * 100)} label="Today's progress" />}
      </PageHeader>

      <NotificationBanner />
      {data.lms?.needsReconnect && (
        <div class="card card-pad banner" role="alert">
          <Icon name="refresh" size={22} />
          <div class="row-main">
            <strong>Reconnect LMS</strong>
            <div class="small muted">The LMS sign-in stopped working, so deadlines aren't updating.</div>
          </div>
          <a class="btn btn-primary btn-small" href="#/lms">
            Reconnect
          </a>
        </div>
      )}

      {/* Two columns on wide screens: today's list on the left, goals and projects beside it. */}
      <div class="dash">
        <div class="dash-main">
          <section class="section card" aria-labelledby="today-title">
            <div class="section-head">
              <h2 class="section-title" id="today-title">
                Today
              </h2>
              <a class="section-link" href={`#/plan/${addDays(data.day, 1)}`}>
                Plan tomorrow
              </a>
            </div>
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
            <NewTask day={data.day} placeholder={'Add a task, e.g. "call bank 3pm p1"'} onAdded={reload} />
          </section>

          {data.unfinished.length > 0 && (
            <section class="section card" aria-labelledby="unfinished-title">
              <div class="section-head">
                <h2 class="section-title" id="unfinished-title">
                  Unfinished <span class="badge badge-red">{data.unfinished.length}</span>
                </h2>
              </div>
              <ul class="list">
                {data.unfinished.map((task) => (
                  <UnfinishedRow key={task.id} task={task} today={data.day} onChanged={reload} />
                ))}
              </ul>
            </section>
          )}
        </div>

        <div class="dash-side">
          <LmsSection lms={data.lms} />

          <section class="section card" aria-labelledby="goals-title">
            <div class="section-head">
              <h2 class="section-title" id="goals-title">
                Monthly goals
              </h2>
              <a class="section-link" href="#/goals">
                All goals
              </a>
            </div>
            {data.goals.length === 0 ? (
              <div class="empty">
                No goals for this month. <a href="#/goals">Add one</a>
              </div>
            ) : (
              data.goals.map((goal) => <GoalCard key={goal.id} goal={goal} plain />)
            )}
          </section>

          <section class="section card" aria-labelledby="projects-title">
            <div class="section-head">
              <h2 class="section-title" id="projects-title">
                Projects
              </h2>
              <a class="section-link" href="#/projects">
                All projects
              </a>
            </div>
            {activeProjects.length === 0 ? (
              <div class="empty">
                No active projects. <a href="#/projects">Start one</a>
              </div>
            ) : (
              activeProjects.map((project) => <ProjectCard key={project.id} project={project} plain />)
            )}
          </section>
        </div>
      </div>
    </>
  );
}
