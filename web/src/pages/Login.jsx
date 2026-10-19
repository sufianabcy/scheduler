import { useState } from 'preact/hooks';
import { post } from '../api.js';
import { ensurePush } from '../push.js';

export function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await post('/auth/login', { email, password });
      // Ask for notifications right away on a device that hasn't been asked yet; the Log in tap is the
      // user action Chrome wants before it shows its prompt. Logging in doesn't wait for the answer.
      if ('Notification' in window && Notification.permission === 'default') ensurePush().catch(() => {});
      onLogin(user);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div class="login">
      <form class="card" onSubmit={submit}>
        <div class="login-hero" aria-hidden="true" />
        <h1>Planner</h1>
        <p>Log in to plan your day.</p>
        {error && (
          <div class="form-error" role="alert">
            {error}
          </div>
        )}
        <div class="field">
          <label for="email">Email</label>
          <input
            id="email"
            class="input"
            type="email"
            autocomplete="username"
            required
            value={email}
            onInput={(e) => setEmail(e.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input
            id="password"
            class="input"
            type="password"
            autocomplete="current-password"
            required
            value={password}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
        </div>
        <button class="btn btn-primary" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
      </form>
    </div>
  );
}
