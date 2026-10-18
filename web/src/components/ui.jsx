import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './Icon.jsx';

/** Round tick box. Plays the web-shot animation when it becomes ticked. */
export function Check({ checked, disabled, onChange, label, priority }) {
  const [shot, setShot] = useState(false);
  const timer = useRef();

  const click = () => {
    if (!checked) {
      clearTimeout(timer.current);
      setShot(true);
      timer.current = setTimeout(() => setShot(false), 600);
    }
    onChange(!checked);
  };

  return (
    <button
      type="button"
      role="checkbox"
      class={`check${shot ? ' shot' : ''}${priority ? ` prio-${priority}` : ''}`}
      aria-checked={checked ? 'true' : 'false'}
      aria-label={label}
      disabled={disabled}
      onClick={click}
    >
      <Icon name="check" size={16} stroke-width={3} />
    </button>
  );
}

export function Progress({ value, label }) {
  return (
    <div class="progress-line">
      <div class="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <span style={{ width: `${value}%` }} />
      </div>
      <span class="progress-pct">{value}%</span>
    </div>
  );
}

/** Text that turns into an input when tapped. Enter or leaving the field saves; Escape cancels. */
export function InlineEdit({ value, onSave, label, class: className = '' }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const input = useRef();

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  if (!editing) {
    return (
      <button
        type="button"
        class={`title-button row-title ${className}`}
        aria-label={`Edit ${label}: ${value}`}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
      >
        {value}
      </button>
    );
  }

  const save = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== value) onSave(next);
  };

  return (
    <input
      ref={input}
      class="input inline-edit"
      aria-label={label}
      value={draft}
      maxLength={200}
      onInput={(e) => setDraft(e.currentTarget.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(value);
          setEditing(false);
        }
      }}
    />
  );
}

/** One-line "add" form at the bottom of a list. */
export function AddRow({ placeholder, onAdd, extra }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const title = text.trim();
    if (!title || busy) return;
    setBusy(true);
    const ok = await onAdd(title);
    setBusy(false);
    if (ok !== false) setText('');
  };

  return (
    <form class="add-row" onSubmit={submit}>
      <input
        class="input"
        placeholder={placeholder}
        aria-label={placeholder}
        value={text}
        maxLength={200}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      {extra}
      <button class="btn btn-primary btn-small" type="submit" disabled={!text.trim() || busy} aria-label="Add">
        <Icon name="plus" size={18} />
      </button>
    </form>
  );
}

/** Up/down buttons. `upDisabled`/`downDisabled` block moves the list's own order wouldn't show (e.g. across priorities). */
export function MoveButtons({ index, count, onMove, label, upDisabled = false, downDisabled = false }) {
  return (
    <>
      <button type="button" class="icon-btn" disabled={index === 0 || upDisabled} aria-label={`Move ${label} up`} onClick={() => onMove(-1)}>
        <Icon name="up" size={18} />
      </button>
      <button
        type="button"
        class="icon-btn"
        disabled={index === count - 1 || downDisabled}
        aria-label={`Move ${label} down`}
        onClick={() => onMove(1)}
      >
        <Icon name="down" size={18} />
      </button>
    </>
  );
}

/** Swaps ids[index] with its neighbour in `direction` (-1 up, +1 down). */
export function moved(ids, index, direction) {
  const next = [...ids];
  [next[index], next[index + direction]] = [next[index + direction], next[index]];
  return next;
}

export function Loading() {
  return <div class="loading">Loading…</div>;
}

export function LoadError({ error, retry }) {
  return (
    <div class="card card-pad empty">
      <p>{error.message}</p>
      <button class="btn" type="button" onClick={retry}>
        Try again
      </button>
    </div>
  );
}
