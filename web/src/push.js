import { get, post } from './api.js';

// Turning notifications on and off for this device (Chrome on Windows, Mac and Android).

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** Fired on window whenever this device's notifications are turned on or off, so screens can refresh. */
export const PUSH_CHANGE = 'pushchange';
const announce = () => window.dispatchEvent(new Event(PUSH_CHANGE));

/** Waits up to `ms` for a promise; resolves to null if it takes longer. */
const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

const toBytes = (base64url) => {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
};

const toBase64url = (buffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/**
 * The service worker registration, or null. Right after the page opens it may still be starting, so this waits
 * a few seconds for it to be ready instead of giving up.
 */
async function registration() {
  if (!pushSupported()) return null;
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing?.active) return existing;
  return (await within(navigator.serviceWorker.ready, 5000)) ?? existing ?? null;
}

export async function currentSubscription() {
  const reg = await registration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** 'insecure' | 'unsupported' | 'no-worker' | 'denied' | 'off' | 'on' */
export async function pushState() {
  // Chrome only allows notifications on https:// addresses (and http://localhost).
  if (!window.isSecureContext) return 'insecure';
  if (!pushSupported()) return 'unsupported';
  if (!(await registration())) return 'no-worker';
  if (Notification.permission === 'denied') return 'denied';
  return (await currentSubscription()) && Notification.permission === 'granted' ? 'on' : 'off';
}

export async function enablePush() {
  if (!window.isSecureContext) throw new Error(pushProblem('insecure'));
  // Ask first: Chrome only shows the permission prompt soon after a tap.
  const permission = await Notification.requestPermission();
  const reg = await registration();
  if (!reg) throw new Error(pushProblem('no-worker'));
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? "Notifications are blocked for this site. Allow them in the browser's site settings."
        : 'Notifications were not allowed.',
    );
  }
  const { publicKey } = await get('/push');
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with an older server key can't receive anything; replace it.
  if (sub && sub.options.applicationServerKey && toBase64url(sub.options.applicationServerKey) !== publicKey) {
    await sub.unsubscribe();
    sub = null;
  }
  try {
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(publicKey) });
  } catch (err) {
    // Usually "AbortError: Registration failed - push service error": Chrome couldn't reach its push service.
    throw new Error(`Couldn't reach Chrome's push service (${err.message}). Check the internet connection and try again.`);
  }
  await post('/push/subscribe', sub.toJSON());
  announce();
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
  announce();
}

/**
 * On app start and after logging in: if Chrome already allows notifications for this site, make sure this
 * device is subscribed and the server has it for this user. No prompt is shown (permission is already given),
 * so a device that lost its subscription (logout, cleared data, new server keys) quietly gets it back.
 */
export async function syncPush() {
  if (!window.isSecureContext || !pushSupported() || Notification.permission !== 'granted') return;
  const sub = await currentSubscription();
  if (sub) await post('/push/subscribe', sub.toJSON()).catch(() => {});
  else await enablePush();
}

/**
 * Called when someone switches on something that needs notifications (a task reminder, a daily notification).
 * If this device hasn't turned them on yet, asks the browser for permission and subscribes.
 * Returns the state afterwards; throws with a readable message if permission was refused.
 */
export async function ensurePush() {
  // Not asked yet on this device: ask at once (nothing awaited first), so Chrome still sees the tap.
  if (window.isSecureContext && 'Notification' in window && Notification.permission === 'default') {
    await enablePush();
    return 'on';
  }
  const state = await pushState();
  if (state !== 'off') return state;
  await enablePush();
  return 'on';
}

/** What to tell the person when notifications can't work on this device, or null if they can. */
export const pushProblem = (state) =>
  ({
    insecure:
      "Chrome only allows notifications on https:// addresses (or http://localhost on this computer). They'll work " +
      'on your phone once the app is online with https. To test on the phone before that: open ' +
      'chrome://flags, find "Insecure origins treated as secure", add this address, and restart Chrome.',
    unsupported: "This browser can't show notifications. Use Chrome.",
    'no-worker': "The app's background worker didn't start. Reload the page and try again.",
    denied:
      "Notifications are blocked for this site. Click the icon left of the address (tune or lock icon) → " +
      'Notifications → Allow, then reload.',
  })[state] ?? null;

/** Step-by-step state of this device, for "Check this device" in More. */
export async function diagnose() {
  const reg = pushSupported() ? await registration() : null;
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  let known = null;
  if (sub) known = (await post('/push/status', { endpoint: sub.endpoint }).catch(() => null))?.known ?? null;
  return [
    { label: 'Secure address (https or localhost)', ok: window.isSecureContext },
    { label: 'Chrome supports notifications here', ok: pushSupported() },
    { label: 'Background worker running', ok: Boolean(reg?.active) },
    { label: `Permission: ${'Notification' in window ? Notification.permission : 'n/a'}`, ok: 'Notification' in window && Notification.permission === 'granted' },
    { label: 'This device is subscribed', ok: Boolean(sub) },
    { label: 'The server knows this device', ok: known === true },
  ];
}

/** Calls `fn` whenever notifications are turned on or off on this device. Returns a function to stop. */
export function onPushChange(fn) {
  window.addEventListener(PUSH_CHANGE, fn);
  return () => window.removeEventListener(PUSH_CHANGE, fn);
}
