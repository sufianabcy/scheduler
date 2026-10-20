import { useState } from 'preact/hooks';
import { Icon } from './Icon.jsx';

// How to install Planner as an app, for each kind of device. Used in the app tour and in More → This device.
// It opens on the tab for the device it's being read on.

const PLATFORMS = [
  {
    id: 'android',
    label: 'Android',
    browser: 'Chrome',
    steps: [
      'Open Planner in Chrome.',
      <>Tap the <b>⋮</b> menu at the top right.</>,
      <>Tap <b>Add to home screen</b>, then <b>Install</b>.</>,
      'Planner is now on your home screen and in your apps.',
    ],
  },
  {
    id: 'ios',
    label: 'iPhone',
    browser: 'Safari',
    steps: [
      'Open Planner in Safari.',
      <>Tap <b>Share</b>, the square with an arrow.</>,
      <>Scroll down and tap <b>Add to Home Screen</b>.</>,
      <>Keep <b>Open as Web App</b> on if you see it, then tap <b>Add</b>.</>,
    ],
    note: 'On iPhone, notifications only work from the Home Screen app.',
  },
  {
    id: 'mac',
    label: 'Mac',
    browser: 'Chrome',
    steps: [
      'Open Planner in Chrome.',
      <>Click the <b>install icon</b> at the right end of the address bar, or <b>⋮</b> → <b>Cast, save and share</b> → <b>Install page as app</b>.</>,
      <>Click <b>Install</b>. Planner opens in its own window.</>,
      <>To keep it handy: right-click its Dock icon → <b>Options</b> → <b>Keep in Dock</b>.</>,
    ],
  },
  {
    id: 'windows',
    label: 'Windows',
    browser: 'Chrome',
    steps: [
      'Open Planner in Chrome.',
      <>Click the <b>install icon</b> at the right end of the address bar, or <b>⋮</b> → <b>Cast, save and share</b> → <b>Install page as app</b>.</>,
      <>Click <b>Install</b>. Planner opens in its own window and gets a Start menu entry.</>,
      <>To keep it handy: right-click its taskbar icon → <b>Pin to taskbar</b>.</>,
    ],
  },
];

/** Which tab to open on: the device this is being read on. */
function thisDevice() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh/.test(ua)) return 'mac';
  return 'android';
}

/** True when Planner is already running as an installed app. */
export function isInstalled() {
  return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}

/** `compact` tightens the spacing and leaves out the "already installed" line (for the tour's picture area). */
export function InstallGuide({ compact = false }) {
  const [tab, setTab] = useState(thisDevice);
  const platform = PLATFORMS.find((p) => p.id === tab);

  return (
    <div class={`install-guide${compact ? ' is-compact' : ''}`}>
      {isInstalled() && !compact && (
        <p class="install-done">
          <Icon name="check" size={14} /> You're using the installed app on this device.
        </p>
      )}
      <div class="chips" role="group" aria-label="Device">
        {PLATFORMS.map((p) => (
          <button key={p.id} type="button" class="chip" aria-pressed={p.id === tab} onClick={() => setTab(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      <ol class="install-steps" aria-label={`${platform.label} with ${platform.browser}`}>
        {platform.steps.map((step, n) => (
          <li key={n}>{step}</li>
        ))}
      </ol>
      {platform.note && <p class="install-note">{platform.note}</p>}
    </div>
  );
}
