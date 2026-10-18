import { useEffect, useState } from 'preact/hooks';
import { ensurePush, onPushChange, pushProblem, pushState } from '../push.js';
import { Icon } from './Icon.jsx';
import { toast } from '../toast.js';
import { SHORT, WEEKDAYS, describeRepeat, presetKey, presets, weekdayOf } from '../repeat.js';

/** "Repeat" choice for a task on `day`: quick options like Google Tasks, plus a custom repeat. */
export function RepeatPicker({ value, day, onChange }) {
  const options = presets(day);
  const [custom, setCustom] = useState(presetKey(value, day) === 'custom');
  const key = custom ? 'custom' : presetKey(value, day);

  const choose = (k) => {
    if (k === 'custom') {
      setCustom(true);
      onChange(value ?? { freq: 'weekly', every: 1, weekdays: [weekdayOf(day)], until: null });
    } else {
      setCustom(false);
      onChange(options.find((o) => o.key === k).value);
    }
  };
  const set = (fields) => onChange({ ...value, ...fields });
  const unit = { daily: 'day', weekly: 'week', monthly: 'month' }[value?.freq];

  return (
    <div class="field">
      <label for={`repeat-${day}`}>Repeat</label>
      <select id={`repeat-${day}`} class="select" value={key} onChange={(e) => choose(e.currentTarget.value)}>
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>

      {custom && value && (
        <div class="custom-repeat">
          <div class="inline-fields">
            <span>Every</span>
            <input
              type="number"
              class="input"
              style={{ width: '72px' }}
              min={1}
              max={99}
              aria-label="Repeat every"
              value={value.every}
              onInput={(e) => {
                const n = Math.min(99, Math.max(1, Number(e.currentTarget.value) || 1));
                set({ every: n });
              }}
            />
            <select
              class="select"
              style={{ width: 'auto' }}
              aria-label="Repeat unit"
              value={value.freq}
              onChange={(e) => {
                const freq = e.currentTarget.value;
                set({ freq, weekdays: freq === 'weekly' ? (value.weekdays?.length ? value.weekdays : [weekdayOf(day)]) : [] });
              }}
            >
              <option value="daily">{value.every === 1 ? 'day' : 'days'}</option>
              <option value="weekly">{value.every === 1 ? 'week' : 'weeks'}</option>
              <option value="monthly">{value.every === 1 ? 'month' : 'months'}</option>
            </select>
          </div>

          {value.freq === 'weekly' && (
            <div class="chips" role="group" aria-label="Repeat on">
              {WEEKDAYS.map((d) => {
                const on = value.weekdays?.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    class="chip"
                    aria-pressed={on}
                    onClick={() => {
                      const next = on ? value.weekdays.filter((x) => x !== d) : WEEKDAYS.filter((x) => x === d || value.weekdays?.includes(x));
                      if (next.length > 0) set({ weekdays: next });
                    }}
                  >
                    {SHORT[d]}
                  </button>
                );
              })}
            </div>
          )}

          <div class="inline-fields">
            <span>Ends</span>
            <select
              class="select"
              style={{ width: 'auto' }}
              aria-label="Repeat ends"
              value={value.until ? 'on' : 'never'}
              onChange={(e) => set({ until: e.currentTarget.value === 'on' ? day : null })}
            >
              <option value="never">Never</option>
              <option value="on">On</option>
            </select>
            {value.until && (
              <input
                type="date"
                class="input"
                style={{ width: 'auto' }}
                aria-label="Repeat ends on"
                min={day}
                value={value.until}
                onChange={(e) => e.currentTarget.value && set({ until: e.currentTarget.value })}
              />
            )}
          </div>
          <div class="small muted">
            {describeRepeat(value, day)}
            {unit === 'month' && ' (or the last day of shorter months)'}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * "Remind me" with a time. Ticking it on a device without notifications asks for permission right away,
 * so the reminder can actually arrive.
 */
export function ReminderPicker({ value, onChange }) {
  const [state, setState] = useState(null);
  useEffect(() => {
    const check = () => pushState().then(setState, () => setState('unsupported'));
    check();
    return onPushChange(check);
  }, []);

  const toggle = async (checked) => {
    onChange(checked ? '09:00' : null);
    if (!checked || state !== 'off') return;
    try {
      setState(await ensurePush());
      toast('Notifications turned on for this device');
    } catch (err) {
      toast(err.message);
      setState(await pushState().catch(() => 'unsupported'));
    }
  };

  const problem = pushProblem(state);
  return (
    <div class="field">
      <label class="toggle-row">
        <input type="checkbox" checked={value !== null} onChange={(e) => toggle(e.currentTarget.checked)} />
        <span>Remind me</span>
        {value !== null && (
          <input
            type="time"
            class="input"
            style={{ width: 'auto', marginLeft: 'auto' }}
            aria-label="Reminder time"
            value={value}
            onChange={(e) => e.currentTarget.value && onChange(e.currentTarget.value)}
          />
        )}
      </label>
      {value !== null && (problem || state === 'off') && (
        <div class="small muted">
          {problem ?? (
            <>
              Notifications are off on this device.{' '}
              <button type="button" class="link-button" onClick={() => toggle(true)}>
                Turn them on
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** None / P1 / P2 / P3. P1 is the most important and is listed first. */
export function PriorityPicker({ value, onChange }) {
  return (
    <div class="field">
      <span class="field-label">Priority</span>
      <div class="chips" role="group" aria-label="Priority">
        {[null, 1, 2, 3].map((p) => (
          <button key={String(p)} type="button" class={`chip${p ? ` prio-chip prio-${p}` : ''}`} aria-pressed={value === p} onClick={() => onChange(p)}>
            {p ? (
              <>
                <Icon name="flag" size={14} /> P{p}
              </>
            ) : (
              'None'
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
