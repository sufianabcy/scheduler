import { useEffect, useRef, useState } from 'preact/hooks';
import { del, get, post } from '../api.js';
import { Icon } from '../components/Icon.jsx';
import { PriorityPicker } from '../components/TaskOptions.jsx';
import { LoadError, Loading, PageHeader } from '../components/ui.jsx';
import { addDays, dayLabel, todayIST } from '../dates.js';
import { attempt, go, useLoad } from '../hooks.js';
import { accountColor, ago, mailDateTime, mailTime, providerApp } from '../mailFormat.js';
import { toast } from '../toast.js';

const Dot = ({ color }) => <span class="mail-dot" style={{ background: accountColor(color) }} aria-hidden="true" />;

/** Inbox / Starred / Accounts, on every Mail screen. */
function MailTabs({ current }) {
  const tab = (key, href, label) => (
    <a class="chip" href={href} aria-current={current === key ? 'page' : undefined}>
      {label}
    </a>
  );
  return (
    <div class="mail-tabs section" role="navigation" aria-label="Mail views">
      {tab('inbox', '#/mail', 'Inbox')}
      {tab('starred', '#/mail/starred', <><Icon name="star" size={14} /> Starred</>)}
      {tab('accounts', '#/mail/accounts', 'Accounts')}
    </div>
  );
}

/** Buttons that start connecting an account: a full-page trip to Google or Microsoft and back. */
function ConnectButtons({ status }) {
  const { google, microsoft } = status.providers;
  if (!google.enabled && !microsoft.enabled) {
    return <p class="small muted">Gmail and Outlook aren't set up on the server yet. See "Mail setup" in the deploy guide.</p>;
  }
  return (
    <div class="btn-row">
      {google.enabled && (
        <a class="btn btn-small" href="/api/mail/connect/google">
          <Icon name="plus" size={16} /> Connect Gmail
        </a>
      )}
      {microsoft.enabled && (
        <a class="btn btn-small" href="/api/mail/connect/microsoft">
          <Icon name="plus" size={16} /> Connect Outlook
        </a>
      )}
    </div>
  );
}

function NotSetUp() {
  return (
    <div class="card card-pad">
      <p>Mail isn't switched on for this server yet.</p>
      <p class="small muted">It needs MAIL_TOKEN_KEY and a Google or Microsoft app registration in the server settings. See "Mail setup" in the deploy guide.</p>
    </div>
  );
}

/** Accounts that need connecting again, each with a one-tap fix. */
function ReconnectBanners({ accounts }) {
  return accounts
    .filter((a) => a.status === 'needs_reconnect')
    .map((a) => (
      <div key={a.id} class="card card-pad banner" role="alert">
        <Icon name="mail" />
        <div class="row-main">
          <strong>{a.email}</strong> stopped syncing.
          <div class="small muted">{a.lastError}</div>
        </div>
        <a class="btn btn-primary btn-small" href={`/api/mail/connect/${a.provider}`}>
          Reconnect
        </a>
      </div>
    ));
}

function StarButton({ message, onChange }) {
  const [busy, setBusy] = useState(false);
  const toggle = async (e) => {
    e.preventDefault();
    setBusy(true);
    const updated = await attempt(post(`/mail/messages/${message.id}/star`, { starred: !message.starred }));
    setBusy(false);
    if (updated) onChange(updated);
  };
  const what = message.provider === 'google' ? 'Star' : 'Flag';
  return (
    <button
      type="button"
      class="icon-btn star-btn"
      aria-pressed={message.starred}
      aria-label={message.starred ? `Remove ${what.toLowerCase()}` : what}
      disabled={busy}
      onClick={toggle}
    >
      <Icon name="star" size={18} fill={message.starred ? 'currentColor' : 'none'} />
    </button>
  );
}

function MailRow({ message, onChange, showAccount }) {
  return (
    <li class={`mail-row${message.unread ? ' is-unread' : ''}`}>
      <a class="mail-link" href={`#/mail/${message.id}`}>
        <span class="mail-top">
          <Dot color={message.color} />
          <span class="mail-from">{message.fromName || message.fromAddress || '(unknown sender)'}</span>
          <span class="mail-time">{mailTime(message.receivedAt)}</span>
        </span>
        <span class="mail-subject">{message.subject || '(no subject)'}</span>
        <span class="mail-snippet">{showAccount ? `${message.account} · ` : ''}{message.snippet}</span>
      </a>
      <StarButton message={message} onChange={onChange} />
    </li>
  );
}

/** The Mail tab: Inbox or Starred, all accounts or one. */
export function MailList({ view = 'inbox' }) {
  const [accountId, setAccountId] = useState(null);
  const [older, setOlder] = useState({ messages: [], hasMore: null });
  const [syncing, setSyncing] = useState(false);
  const setup = useLoad(() => Promise.all([get('/mail/status'), get('/mail/accounts')]), []);
  const list = useLoad(() => get(`/mail/messages?view=${view}${accountId ? `&account=${accountId}` : ''}`), [view, accountId]);

  useEffect(() => setOlder({ messages: [], hasMore: null }), [view, accountId]);

  if (!setup.data) return setup.error ? <LoadError error={setup.error} retry={setup.reload} /> : <Loading />;
  const [status, { accounts }] = setup.data;

  const syncNow = async () => {
    setSyncing(true);
    const res = await attempt(post('/mail/sync'));
    setSyncing(false);
    if (res) {
      setup.reload();
      list.reload();
    }
  };
  const replace = (updated) => {
    list.setData({ ...list.data, messages: list.data.messages.map((m) => (m.id === updated.id ? updated : m)) });
    setOlder((o) => ({ ...o, messages: o.messages.map((m) => (m.id === updated.id ? updated : m)) }));
  };
  const loadOlder = async () => {
    const shown = [...(list.data?.messages ?? []), ...older.messages];
    const last = shown.at(-1);
    const res = await attempt(get(`/mail/messages?view=${view}${accountId ? `&account=${accountId}` : ''}&before=${encodeURIComponent(last.receivedAt)}`));
    if (res) setOlder({ messages: [...older.messages, ...res.messages], hasMore: res.hasMore });
  };

  const unread = accounts.reduce((n, a) => n + a.unread, 0);
  const lastSync = accounts.map((a) => a.lastSyncedAt).filter(Boolean).sort().at(-1);
  const messages = [...(list.data?.messages ?? []), ...older.messages];
  const hasMore = older.hasMore ?? list.data?.hasMore;

  return (
    <>
      <PageHeader
        title="Mail"
        sub={accounts.length ? `${unread} unread · synced ${ago(lastSync)}` : 'Gmail and Outlook in one inbox'}
        aside={
          accounts.length > 0 && (
            <button type="button" class="icon-btn" aria-label="Sync now" disabled={syncing} onClick={syncNow}>
              <Icon name="refresh" />
            </button>
          )
        }
      />

      {!status.enabled ? (
        <NotSetUp />
      ) : accounts.length === 0 ? (
        <div class="card card-pad">
          <p>Connect your mail to see it here and turn any mail into a task.</p>
          <ConnectButtons status={status} />
        </div>
      ) : (
        <>
          <ReconnectBanners accounts={accounts} />
          <MailTabs current={view} />
          {accounts.length > 1 && (
            <div class="chips" role="group" aria-label="Show mail from" style={{ marginBottom: '10px' }}>
              <button type="button" class="chip" aria-pressed={accountId === null} onClick={() => setAccountId(null)}>
                All
              </button>
              {accounts.map((a) => (
                <button key={a.id} type="button" class="chip" aria-pressed={accountId === a.id} onClick={() => setAccountId(a.id)} style={{ gap: '6px' }}>
                  <Dot color={a.color} /> {a.email}
                </button>
              ))}
            </div>
          )}

          {!list.data ? (
            list.error ? <LoadError error={list.error} retry={list.reload} /> : <Loading />
          ) : (
            <div class="card">
              <ul class="list">
                {messages.map((m) => (
                  <MailRow key={m.id} message={m} onChange={replace} showAccount={accounts.length > 1 && accountId === null} />
                ))}
                {messages.length === 0 && (
                  <li class="empty">
                    {view === 'starred'
                      ? 'Nothing starred. Star a mail here or in Gmail / Outlook.'
                      : accounts.some((a) => !a.lastSyncedAt)
                        ? 'Fetching your mail…'
                        : 'No mail from the last 30 days.'}
                  </li>
                )}
              </ul>
              {hasMore && (
                <div class="card-pad">
                  <button type="button" class="btn btn-small" onClick={loadOlder}>
                    Show older
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}

/** "Make task" on a mail: the subject as the title, Today or Tomorrow, optional priority. */
function MakeTask({ message, onDone }) {
  const today = todayIST();
  const [title, setTitle] = useState(message.subject || '(no subject)');
  const [day, setDay] = useState(today);
  const [priority, setPriority] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    const res = await attempt(post(`/mail/messages/${message.id}/task`, { title: title.trim(), day, priority }));
    setBusy(false);
    if (res) {
      toast(`Added to ${dayLabel(day, today)}`);
      onDone();
    }
  };

  return (
    <form class="editor card card-pad" onSubmit={submit} style={{ marginTop: '12px' }}>
      <div class="field">
        <label for="mail-task-title">Task</label>
        <input id="mail-task-title" class="input" maxLength={200} value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
      </div>
      <div class="field">
        <span class="field-label">Day</span>
        <div class="chips">
          <button type="button" class="chip" aria-pressed={day === today} onClick={() => setDay(today)}>
            Today
          </button>
          <button type="button" class="chip" aria-pressed={day === addDays(today, 1)} onClick={() => setDay(addDays(today, 1))}>
            Tomorrow
          </button>
          <input
            type="date"
            class="input"
            style={{ width: 'auto', minHeight: '32px', padding: '2px 8px' }}
            aria-label="Another day"
            min={today}
            value={day}
            onChange={(e) => e.currentTarget.value && setDay(e.currentTarget.value)}
          />
        </div>
      </div>
      <PriorityPicker value={priority} onChange={setPriority} />
      <div class="btn-row">
        <button class="btn btn-primary btn-small" type="submit" disabled={busy || !title.trim()}>
          Add task
        </button>
        <button class="btn btn-ghost btn-small" type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** One mail: header, actions, and the body in a sandboxed frame (remote images off until asked). */
export function MailDetail({ id }) {
  const { data: message, error, reload, setData } = useLoad(() => get(`/mail/messages/${id}`), [id]);
  const [images, setImages] = useState(false);
  const [making, setMaking] = useState(false);
  const frame = useRef();

  // The body is same-origin (and script-free), so the frame can be sized to fit it.
  const fit = () => {
    try {
      const doc = frame.current.contentDocument;
      frame.current.style.height = `${doc.documentElement.scrollHeight + 4}px`;
    } catch {
      frame.current.style.height = '480px';
    }
  };

  if (!message) return error ? <LoadError error={error} retry={reload} /> : <Loading />;
  const app = providerApp(message.provider);

  return (
    <>
      <div class="section-head" style={{ marginTop: '6px' }}>
        <button type="button" class="btn btn-ghost btn-small" onClick={() => (history.length > 1 ? history.back() : go('/mail'))}>
          <Icon name="left" size={16} /> Mail
        </button>
      </div>
      <div class="card card-pad mail-head">
        <h2>{message.subject || '(no subject)'}</h2>
        <div class="meta-line row-meta">
          <span>
            <strong>{message.fromName || message.fromAddress}</strong>
            {message.fromName && message.fromAddress && <> &lt;{message.fromAddress}&gt;</>}
          </span>
        </div>
        <div class="meta-line row-meta">
          <span>
            <Dot color={message.color} /> {message.account}
          </span>
          <span>{mailDateTime(message.receivedAt)}</span>
        </div>
        <div class="btn-row" style={{ marginTop: '12px', alignItems: 'center' }}>
          <button type="button" class="btn btn-primary btn-small" aria-expanded={making} onClick={() => setMaking(!making)}>
            <Icon name="plus" size={16} /> Make task
          </button>
          <StarButton message={message} onChange={setData} />
          <button type="button" class="btn btn-ghost btn-small" aria-pressed={images} onClick={() => setImages(!images)}>
            <Icon name="image" size={16} /> {images ? 'Hide images' : 'Show images'}
          </button>
          {message.webLink && (
            <a class="btn btn-ghost btn-small" href={message.webLink} target="_blank" rel="noopener noreferrer">
              <Icon name="external" size={16} /> Open in {app}
            </a>
          )}
        </div>
        {making && <MakeTask message={message} onDone={() => setMaking(false)} />}
      </div>
      <div class="section">
        <iframe
          key={images ? 'with-images' : 'plain'}
          ref={frame}
          class="mail-frame"
          title={`Mail: ${message.subject}`}
          src={`/api/mail/messages/${message.id}/body${images ? '?images=1' : ''}`}
          sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
          referrerpolicy="no-referrer"
          onLoad={fit}
        />
        {!images && <p class="small muted">Images from the web are off, so senders can't tell you opened the mail.</p>}
      </div>
    </>
  );
}

/** Connected accounts: status, reconnect, disconnect, and connect new ones. */
export function MailAccounts() {
  const { data, error, reload } = useLoad(() => Promise.all([get('/mail/status'), get('/mail/accounts')]), []);

  // Coming back from Google or Microsoft: say how it went, once, then tidy the address.
  useEffect(() => {
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
    if (params.get('connected')) toast(`Connected ${params.get('connected')}`);
    if (params.get('error')) toast(params.get('error'));
    if (params.size) history.replaceState(null, '', '#/mail/accounts');
  }, []);

  // A new account syncs in the background; refresh until its first sync is done (up to about a minute).
  const waiting = data?.[1].accounts.some((a) => a.status === 'ok' && !a.lastSyncedAt);
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setTimeout(reload, 3000);
    return () => clearTimeout(timer);
  }, [data]);

  if (!data) return error ? <LoadError error={error} retry={reload} /> : <Loading />;
  const [status, { accounts }] = data;

  const disconnect = async (a) => {
    const note = a.provider === 'microsoft' ? ' To also remove its access at Microsoft, visit account.live.com/consent/Manage.' : '';
    if (!confirm(`Disconnect ${a.email}? Its mail is removed from the app; tasks made from it keep their link.${note}`)) return;
    if ((await attempt(del(`/mail/accounts/${a.id}`))) !== undefined) reload();
  };

  return (
    <>
      <PageHeader title="Mail accounts" sub="Connected through the provider's own sign-in. The app never sees your passwords." />
      {!status.enabled ? (
        <NotSetUp />
      ) : (
        <>
          {accounts.length > 0 && <MailTabs current="accounts" />}
          <div class="card">
            <ul class="list">
              {accounts.map((a) => (
                <li key={a.id} class="row" style={{ flexWrap: 'wrap' }}>
                  <Dot color={a.color} />
                  <div class="row-main">
                    <div class="row-title">{a.email}</div>
                    <div class="row-meta meta-line">
                      <span>{a.providerLabel}</span>
                      {a.status === 'needs_reconnect' ? (
                        <span class="prio-text prio-1">Needs reconnecting</span>
                      ) : a.lastError ? (
                        <span class="prio-text prio-2">Last sync failed: {a.lastError}</span>
                      ) : (
                        <span>{a.lastSyncedAt ? `Synced ${ago(a.lastSyncedAt)}` : 'Fetching mail…'}</span>
                      )}
                    </div>
                  </div>
                  {a.status === 'needs_reconnect' && (
                    <a class="btn btn-primary btn-small" href={`/api/mail/connect/${a.provider}`}>
                      Reconnect
                    </a>
                  )}
                  <button type="button" class="btn btn-ghost btn-small btn-danger" onClick={() => disconnect(a)}>
                    Disconnect
                  </button>
                </li>
              ))}
              {accounts.length === 0 && <li class="empty">No mail accounts yet.</li>}
            </ul>
          </div>
          <div class="section">
            <ConnectButtons status={status} />
            <p class="small muted" style={{ marginTop: '12px' }}>
              Inbox mail from the last 30 days is synced every 5 minutes (sender, subject and preview only). A mail's text is
              fetched when you open it and never stored.
            </p>
          </div>
        </>
      )}
    </>
  );
}
