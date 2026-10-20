import { useState } from 'preact/hooks';
import { get, post } from '../api.js';
import { Icon } from '../components/Icon.jsx';
import { LoadError, Loading, PageHeader } from '../components/ui.jsx';
import { attempt, useLoad } from '../hooks.js';
import { toast } from '../toast.js';

// Readable characters only (no 0/O, 1/l/I), so a password read out or typed from a message comes out right.
const CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newPassword(length = 14) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => CHARS[b % CHARS.length]).join('');
}

/** created_at is UTC 'YYYY-MM-DD HH:MM:SS'; shown as an IST date. */
const joined = (createdAt) =>
  new Date(`${createdAt.replace(' ', 'T')}Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/** Admin only: the login accounts, and a form to create one. Making someone an admin stays on the server's command line. */
export function Users({ user }) {
  const { data, error, reload } = useLoad(() => (user.isAdmin ? get('/admin/users') : Promise.resolve(null)), []);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null); // { email, password } to pass on

  if (!user.isAdmin) {
    return (
      <>
        <PageHeader title="Users" />
        <div class="card card-pad">Only an admin can manage users.</div>
      </>
    );
  }
  if (!data) return error ? <LoadError error={error} retry={reload} /> : <Loading />;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    const res = await attempt(post('/admin/users', { email, password }));
    setBusy(false);
    if (!res) return;
    setCreated({ email: res.user.email, password });
    setEmail('');
    setPassword('');
    reload();
  };

  const copy = async () => {
    const text = `Planner: ${location.origin}\nEmail: ${created.email}\nPassword: ${created.password}`;
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch {
      toast("Couldn't copy; select the text instead");
    }
  };

  return (
    <>
      <PageHeader title="Users" sub="Who can log in. New accounts get the password you set here." />

      {created && (
        <div class="card card-pad section" role="status">
          <strong>Created {created.email}</strong>
          <p class="small muted" style={{ margin: '6px 0 12px' }}>
            Send them the email and password. The password isn't shown again.
          </p>
          <div class="new-login">
            <div>{created.email}</div>
            <div class="mono">{created.password}</div>
          </div>
          <div class="btn-row" style={{ marginTop: '12px' }}>
            <button type="button" class="btn btn-small" onClick={copy}>
              Copy login details
            </button>
            <button type="button" class="btn btn-ghost btn-small" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      <section class="section card">
        <div class="section-head">
          <h2 class="section-title">Accounts</h2>
        </div>
        <ul class="list">
          {data.users.map((u) => (
            <li key={u.id} class="row">
              <Icon name="user" size={18} />
              <div class="row-main">
                <div class="row-title">{u.email}</div>
                <div class="row-meta">Since {joined(u.createdAt)}</div>
              </div>
              {u.isAdmin && <span class="badge">Admin</span>}
            </li>
          ))}
        </ul>
      </section>

      <section class="section card card-pad">
        <h2 class="section-title" style={{ marginBottom: '12px' }}>
          New user
        </h2>
        <form onSubmit={submit}>
          <div class="field">
            <label for="new-email">Email</label>
            <input
              id="new-email"
              class="input"
              type="email"
              autocomplete="off"
              required
              maxLength={254}
              value={email}
              onInput={(e) => setEmail(e.currentTarget.value)}
            />
          </div>
          <div class="field">
            <label for="new-password">Password</label>
            <div class="input-row">
              {/* Shown as text: the admin has to pass it on. */}
              <input
                id="new-password"
                class="input mono"
                type="text"
                autocomplete="new-password"
                spellcheck={false}
                required
                minLength={8}
                maxLength={200}
                value={password}
                onInput={(e) => setPassword(e.currentTarget.value)}
              />
              <button type="button" class="btn btn-small" onClick={() => setPassword(newPassword())}>
                Make one
              </button>
            </div>
            <div class="small muted" style={{ marginTop: '6px' }}>
              At least 8 characters.
            </div>
          </div>
          <button class="btn btn-primary" type="submit" disabled={busy || !email.trim() || password.length < 8}>
            {busy ? 'Creating…' : 'Create user'}
          </button>
        </form>
      </section>
    </>
  );
}
