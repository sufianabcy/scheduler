import { get, post } from './api.js';

// Turning notifications on and off for this device. The server sends them at 23:00 and 06:00 IST.

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const toBytes = (base64url) => {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
};

const toBase64url = (buffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** The service worker registration, or null (it only exists in the built app, not the dev server). */
const registration = async () => (pushSupported() ? (await navigator.serviceWorker.getRegistration()) ?? null : null);

export async function currentSubscription() {
  const reg = await registration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** 'unsupported' | 'no-worker' | 'denied' | 'off' | 'on' */
export async function pushState() {
  if (!pushSupported()) return 'unsupported';
  if (!(await registration())) return 'no-worker';
  if (Notification.permission === 'denied') return 'denied';
  return (await currentSubscription()) && Notification.permission === 'granted' ? 'on' : 'off';
}

export async function enablePush() {
  const reg = await registration();
  if (!reg) throw new Error('Notifications only work in the built or installed app.');
  const permission = await Notification.requestPermission();
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
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(publicKey) });
  await post('/push/subscribe', sub.toJSON());
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

/** After logging in: make sure the server knows this device's subscription belongs to this user. */
export async function syncPush() {
  if ((await pushState()) !== 'on') return;
  const sub = await currentSubscription();
  await post('/push/subscribe', sub.toJSON()).catch(() => {});
}
