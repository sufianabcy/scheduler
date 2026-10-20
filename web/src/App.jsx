import { useEffect, useState } from 'preact/hooks';
import { get, post, setLoggedOutHandler } from './api.js';
import { Icon } from './components/Icon.jsx';
import { Loading } from './components/ui.jsx';
import { useOnline, useRoute } from './hooks.js';
import { GoalDetail, GoalList } from './pages/Goals.jsx';
import { Lms, LmsMissed } from './pages/Lms.jsx';
import { Login } from './pages/Login.jsx';
import { MailAccounts, MailDetail, MailList } from './pages/Mail.jsx';
import { More } from './pages/More.jsx';
import { Plan } from './pages/Plan.jsx';
import { ProjectDetail, ProjectList } from './pages/Projects.jsx';
import { Today } from './pages/Today.jsx';
import { Users } from './pages/Users.jsx';
import { disablePush, syncPush } from './push.js';
import { useToast } from './toast.js';

// Plan holds the day plan, monthly goals and projects (switched with tabs on those pages).
const NAV = [
  { path: '/', sections: [''], label: 'Today', icon: 'home' },
  { path: '/plan', sections: ['plan', 'goals', 'projects'], label: 'Plan', icon: 'calendar' },
  { path: '/mail', sections: ['mail'], label: 'Mail', icon: 'mail' },
  { path: '/lms', sections: ['lms'], label: 'LMS', icon: 'cap' },
  { path: '/more', sections: ['more', 'users'], label: 'More', icon: 'more' },
];

/** Picks the page for a hash route like '/goals/12' (anything after '?' is for the page itself). */
function page(route, user, onLogout) {
  const [section, a, b] = route.split('?')[0].split('/').filter(Boolean);
  switch (section) {
    case undefined:
      return <Today />;
    case 'plan':
      return <Plan day={a} />;
    case 'goals':
      if (a === 'm') return <GoalList month={b} />;
      return a ? <GoalDetail id={a} /> : <GoalList />;
    case 'projects':
      return a ? <ProjectDetail id={a} /> : <ProjectList />;
    case 'mail':
      if (a === 'accounts') return <MailAccounts />;
      if (a === 'starred') return <MailList view="starred" />;
      return a ? <MailDetail id={a} /> : <MailList />;
    case 'more':
      return <More user={user} onLogout={onLogout} />;
    case 'lms':
      return a === 'missed' ? <LmsMissed /> : <Lms />;
    case 'users':
      return <Users user={user} />;
    default:
      return <Today />;
  }
}

/** Forgets data the offline cache kept for this user. */
async function clearOfflineData() {
  if ('caches' in window) await caches.delete('api').catch(() => {});
}

export function App() {
  // undefined = still checking, null = logged out.
  const [user, setUser] = useState(undefined);
  const [offlineStart, setOfflineStart] = useState(false);
  const route = useRoute();
  const online = useOnline();
  const message = useToast();

  const checkSession = () => {
    setOfflineStart(false);
    get('/auth/me')
      .then((data) => setUser(data.user))
      .catch((err) => {
        if (err.status === 0) setOfflineStart(true);
        else setUser(null);
      });
  };

  useEffect(() => {
    setLoggedOutHandler(() => {
      clearOfflineData();
      setUser(null);
    });
    checkSession();
  }, []);

  // Keep this device's notifications working: sync when logged in, retry a few times if Chrome's push service
  // is slow to answer (it can be on a fresh install), and check again whenever the app comes back to the front.
  useEffect(() => {
    if (!user) return undefined;
    let timer;
    const trySync = (attemptNo) =>
      syncPush().catch(() => {
        if (attemptNo < 4) timer = setTimeout(() => trySync(attemptNo + 1), 5000 * 2 ** attemptNo);
      });
    trySync(0);
    // Ask the server to refresh LMS deadlines; it does so at most every 10 minutes, in the background.
    const syncLms = () => post('/lms/sync', { auto: true }).catch(() => {});
    syncLms();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      syncPush().catch(() => {});
      syncLms();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [user]);

  const logout = async () => {
    // Stop this device's notifications first, while the session still exists to tell the server.
    await disablePush().catch(() => {});
    await post('/auth/logout').catch(() => {});
    await clearOfflineData();
    setUser(null);
  };

  if (user === undefined) {
    return offlineStart ? (
      <div class="login">
        <div class="card empty">
          <p>You're offline and this device has no saved copy yet.</p>
          <button class="btn" type="button" onClick={checkSession}>
            Try again
          </button>
        </div>
      </div>
    ) : (
      <Loading />
    );
  }
  if (user === null) return <Login onLogin={setUser} />;

  const section = route.split('?')[0].split('/').filter(Boolean)[0] ?? '';
  return (
    <div class="shell">
      <nav class="nav" aria-label="Main">
        <div class="brand">
          <img src="/icons/icon-192.png" alt="" />
          Planner
        </div>
        {NAV.map((item) => (
          <a key={item.path} href={`#${item.path}`} aria-current={item.sections.includes(section) ? 'page' : undefined}>
            <Icon name={item.icon} size={22} />
            {item.label}
          </a>
        ))}
      </nav>
      <main class="main">
        {!online && <div class="offline">You're offline. Showing the last saved copy; changes need internet.</div>}
        {page(route, user, logout)}
      </main>
      {message && (
        <div class="toast" role="status">
          {message}
        </div>
      )}
    </div>
  );
}
