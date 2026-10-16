import { del, patch } from '../api.js';
import { attempt } from '../hooks.js';
import { Icon } from './Icon.jsx';
import { Check, InlineEdit } from './ui.jsx';

/** One daily-plan task: tick, rename, delete. `children` adds extra buttons (e.g. reorder). */
export function TaskRow({ task, onChanged, readOnly, children }) {
  const done = task.status === 'done';
  const missed = task.status === 'missed';

  const change = async (body) => {
    if (await attempt(patch(`/tasks/${task.id}`, body))) onChanged();
  };
  const remove = async () => {
    const note = task.repeating ? ' It will still repeat on its other days.' : '';
    if (!confirm(`Delete "${task.title}"?${note}`)) return;
    if ((await attempt(del(`/tasks/${task.id}`))) !== undefined) onChanged();
  };

  return (
    <li class={`row${done ? ' is-done' : ''}${missed ? ' is-locked' : ''}`}>
      <Check checked={done} disabled={readOnly || missed} label={`Done: ${task.title}`} onChange={(v) => change({ done: v })} />
      <div class="row-main">
        {readOnly ? (
          <span class="row-title">{task.title}</span>
        ) : (
          <InlineEdit value={task.title} label="task" onSave={(title) => change({ title })} />
        )}
        {(task.repeating || missed) && (
          <div class="row-meta">
            {task.repeating && (
              <span title="Repeating task">
                <Icon name="repeat" size={13} /> repeats
              </span>
            )}
            {missed && ' · missed'}
          </div>
        )}
      </div>
      {children}
      {!readOnly && (
        <button type="button" class="icon-btn" aria-label={`Delete ${task.title}`} onClick={remove}>
          <Icon name="trash" size={18} />
        </button>
      )}
    </li>
  );
}
