import { useMemo, useState } from 'preact/hooks';
import { del, patch, post } from '../api.js';
import { dayLabel, formatTime, todayIST } from '../dates.js';
import { attempt } from '../hooks.js';
import { parseQuickAdd } from '../quickadd.js';
import { describeRepeat, repeatBody, sameRepeat } from '../repeat.js';
import { toast } from '../toast.js';
import { Icon } from './Icon.jsx';
import { PriorityPicker, ReminderPicker, RepeatPicker } from './TaskOptions.jsx';
import { Check } from './ui.jsx';

/** The small line with a task's repeat and reminder (under it on phones, on its right on wider screens). */
function TaskMeta({ task, extra }) {
  const parts = [];
  if (task.repeat) {
    parts.push(
      <span key="r">
        <Icon name="repeat" size={13} /> {describeRepeat(task.repeat, task.day)}
      </span>,
    );
  }
  if (task.remindAt) {
    parts.push(
      <span key="b">
        <Icon name="bell" size={13} /> {formatTime(task.remindAt)}
      </span>,
    );
  }
  if (extra) parts.push(<span key="x">{extra}</span>);
  if (parts.length === 0) return null;
  return <div class="row-meta meta-line">{parts}</div>;
}

function PriorityDot({ priority }) {
  if (!priority) return null;
  return <span class={`prio-dot prio-${priority}`} role="img" aria-label={`Priority ${priority}`} title={`P${priority}`} />;
}

/** Edits a task's title, repeat and reminder. Repeat and reminder changes apply to the whole series. */
function TaskEditor({ task, onSaved, onCancel, onDelete }) {
  const [title, setTitle] = useState(task.title);
  const [repeat, setRepeat] = useState(task.repeat);
  const [remindAt, setRemindAt] = useState(task.remindAt);
  const [priority, setPriority] = useState(task.priority);
  const [busy, setBusy] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    const body = {};
    if (title.trim() && title.trim() !== task.title) body.title = title.trim();
    if (!sameRepeat(repeat, task.repeat)) body.repeat = repeatBody(repeat);
    if (remindAt !== task.remindAt) body.remindAt = remindAt;
    if (priority !== task.priority) body.priority = priority;
    if (Object.keys(body).length === 0) return onCancel();
    setBusy(true);
    const res = await attempt(patch(`/tasks/${task.id}`, body));
    setBusy(false);
    if (res) onSaved();
  };

  return (
    <form class="editor" onSubmit={save}>
      <div class="field">
        <label for={`title-${task.id}`}>Task</label>
        <input id={`title-${task.id}`} class="input" maxLength={200} value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
      </div>
      <PriorityPicker value={priority} onChange={setPriority} />
      <RepeatPicker value={repeat} day={task.day} onChange={setRepeat} />
      <ReminderPicker value={remindAt} onChange={setRemindAt} />
      {task.repeat && <p class="small muted">Changes apply to this task and its upcoming repeats.</p>}
      <div class="btn-row">
        <button class="btn btn-primary btn-small" type="submit" disabled={busy || !title.trim()}>
          Save
        </button>
        <button class="btn btn-ghost btn-small" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button class="btn btn-ghost btn-small btn-danger" type="button" style={{ marginLeft: 'auto' }} onClick={onDelete}>
          <Icon name="trash" size={16} /> Delete
        </button>
      </div>
    </form>
  );
}

/** One daily-plan task: tick it, or tap its title to edit title, repeat and reminder. */
export function TaskRow({ task, onChanged, readOnly, children }) {
  const [editing, setEditing] = useState(false);
  const done = task.status === 'done';
  const missed = task.status === 'missed';

  const tick = async (value) => {
    if (await attempt(patch(`/tasks/${task.id}`, { done: value }))) onChanged();
  };
  const remove = async () => {
    const note = task.repeating ? ' It still repeats on its other days.' : '';
    if (!confirm(`Delete "${task.title}" from this day?${note}`)) return;
    if ((await attempt(del(`/tasks/${task.id}`))) !== undefined) onChanged();
  };

  return (
    <li class={`row task-row${done ? ' is-done' : ''}${missed ? ' is-locked' : ''}`} style={{ flexWrap: 'wrap' }}>
      <Check checked={done} disabled={readOnly || missed} label={`Done: ${task.title}`} onChange={tick} priority={task.priority} />
      <div class="row-main">
        {readOnly ? (
          <span class="row-title">
            <PriorityDot priority={task.priority} />
            {task.title}
          </span>
        ) : (
          <button type="button" class="title-button row-title" aria-expanded={editing} aria-label={`Edit ${task.title}`} onClick={() => setEditing(!editing)}>
            <PriorityDot priority={task.priority} />
            {task.title}
          </button>
        )}
        <TaskMeta task={task} extra={missed ? 'missed' : null} />
      </div>
      {children}
      {editing && (
        <TaskEditor
          task={task}
          onCancel={() => setEditing(false)}
          onDelete={remove}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}
    </li>
  );
}

/** A short line saying what quick add understood, e.g. "Tomorrow · 07:00 · Weekly on Mon, Wed · P1". */
function QuickAddPreview({ parsed, today, onIgnore }) {
  const bits = [];
  if (parsed.day) bits.push(<span key="d"><Icon name="calendar" size={13} /> {dayLabel(parsed.day, today)}</span>);
  if (parsed.remindAt) bits.push(<span key="t"><Icon name="bell" size={13} /> {formatTime(parsed.remindAt)}</span>);
  if (parsed.repeat) bits.push(<span key="r"><Icon name="repeat" size={13} /> {describeRepeat(parsed.repeat, parsed.day ?? today)}</span>);
  if (parsed.priority) {
    bits.push(
      <span key="p" class={`prio-text prio-${parsed.priority}`}>
        <Icon name="flag" size={13} /> P{parsed.priority}
      </span>,
    );
  }
  return (
    <div class="quick-preview" aria-live="polite">
      <div class="meta-line">
        <strong>{parsed.title}</strong>
        {bits}
      </div>
      <button type="button" class="link-button small" onClick={onIgnore}>
        Keep text as typed
      </button>
    </div>
  );
}

/**
 * Add a task to `day`. Typing "gym tomorrow 7am every mon wed p1" fills in the day, reminder, repeat and
 * priority (shown before adding). The bell button opens the same options as pickers; what's picked there wins.
 */
export function NewTask({ day, placeholder, onAdded }) {
  const today = todayIST();
  const [title, setTitle] = useState('');
  const [literal, setLiteral] = useState(false);
  const [options, setOptions] = useState(false);
  const [repeat, setRepeat] = useState(null);
  const [remindAt, setRemindAt] = useState(null);
  const [priority, setPriority] = useState(null);
  const [busy, setBusy] = useState(false);

  const parsed = useMemo(() => {
    if (literal || !title.trim()) return null;
    const p = parseQuickAdd(title, today);
    return p.found.length > 0 && p.title ? p : null;
  }, [title, literal, today]);

  const submit = async (e) => {
    e.preventDefault();
    const text = title.trim();
    if (!text || busy) return;
    const target = parsed?.day ?? day;
    const body = {
      title: parsed?.title ?? text,
      repeat: repeatBody(repeat ?? parsed?.repeat ?? null),
      remindAt: remindAt ?? parsed?.remindAt ?? null,
      priority: priority ?? parsed?.priority ?? null,
    };
    setBusy(true);
    const res = await attempt(post(`/days/${target}/tasks`, body));
    setBusy(false);
    if (!res) return;
    if (res.firstDay !== target) {
      toast(res.firstDay ? `Added. It first happens on ${dayLabel(res.firstDay, today)}.` : 'Added, but that repeat never happens.');
    } else if (target !== day) {
      toast(`Added to ${dayLabel(target, today)}`);
    }
    setTitle('');
    setLiteral(false);
    setRepeat(null);
    setRemindAt(null);
    setPriority(null);
    setOptions(false);
    onAdded(res);
  };

  const summary = [priority && `P${priority}`, repeat && describeRepeat(repeat, day), remindAt && `reminder ${formatTime(remindAt)}`].filter(Boolean).join(' · ');

  return (
    <form onSubmit={submit}>
      {options && (
        <div class="editor" style={{ margin: '0 10px', width: 'auto' }}>
          <PriorityPicker value={priority} onChange={setPriority} />
          <RepeatPicker value={repeat} day={parsed?.day ?? day} onChange={setRepeat} />
          <ReminderPicker value={remindAt} onChange={setRemindAt} />
        </div>
      )}
      {!options && summary && <div class="small muted" style={{ padding: '8px 12px 0' }}>{summary}</div>}
      {parsed && <QuickAddPreview parsed={parsed} today={today} onIgnore={() => setLiteral(true)} />}
      <div class="add-row">
        <input
          class="input"
          placeholder={placeholder}
          aria-label={placeholder}
          value={title}
          maxLength={200}
          onInput={(e) => {
            setTitle(e.currentTarget.value);
            if (!e.currentTarget.value) setLiteral(false);
          }}
        />
        <button
          type="button"
          class={`icon-btn${repeat || remindAt || priority ? ' is-set' : ''}`}
          aria-label="Priority, repeat and reminder"
          aria-expanded={options}
          onClick={() => setOptions(!options)}
        >
          <Icon name="bell" size={18} />
        </button>
        <button class="btn btn-primary btn-round" type="submit" disabled={!title.trim() || busy} aria-label="Add">
          <Icon name="plus" size={18} />
        </button>
      </div>
    </form>
  );
}
