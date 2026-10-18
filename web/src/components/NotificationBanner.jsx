import { useEffect, useState } from 'preact/hooks';
import { ensurePush, onPushChange, pushProblem, pushState } from '../push.js';
import { toast } from '../toast.js';
import { Icon } from './Icon.jsx';

const KEY = 'notification-banner-hidden';
const hidden = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * Shown on Today while this device can't get notifications yet: a button that brings up Chrome's
 * "Allow notifications?" prompt, or what to fix if they're blocked. "Not now" hides it on this device.
 */
export function NotificationBanner() {
  const [state, setState] = useState(null);
  const [gone, setGone] = useState(hidden());
  useEffect(() => {
    const check = () => pushState().then(setState, () => setState('unsupported'));
    check();
    return onPushChange(check);
  }, []);

  if (gone || !state || state === 'on' || state === 'unsupported') return null;

  const allow = async () => {
    try {
      setState(await ensurePush());
      toast('Notifications are on for this device');
    } catch (err) {
      toast(err.message);
      setState(await pushState().catch(() => 'unsupported'));
    }
  };
  const dismiss = () => {
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      // Not saved; it just comes back next time.
    }
    setGone(true);
  };

  return (
    <div class="card card-pad banner" role="region" aria-label="Notifications">
      <Icon name="bell" size={22} />
      <div class="row-main">
        <strong>Get your reminders on this device</strong>
        <div class="small muted">{state === 'off' ? 'Allow notifications so reminders and the daily plan reach you.' : pushProblem(state)}</div>
      </div>
      <div class="btn-row">
        {state === 'off' && (
          <button type="button" class="btn btn-primary btn-small" onClick={allow}>
            Allow
          </button>
        )}
        <button type="button" class="btn btn-ghost btn-small" onClick={dismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}
