-- Mail: connected Gmail / Outlook accounts and a light copy of their recent inbox (no bodies).

-- refresh_token is encrypted with MAIL_TOKEN_KEY (see mail/crypto.js); the key is never stored in the database.
-- sync_cursor: Gmail historyId or Microsoft Graph deltaLink. color: 1–6, an account colour from theme.css.
CREATE TABLE mail_accounts (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  email          TEXT NOT NULL,
  color          INTEGER NOT NULL DEFAULT 1,
  refresh_token  TEXT NOT NULL,
  scopes         TEXT NOT NULL DEFAULT '',
  sync_cursor    TEXT,
  last_synced_at TEXT,
  status         TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'needs_reconnect')),
  last_error     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, provider, email COLLATE NOCASE)
);
CREATE INDEX mail_accounts_user ON mail_accounts(user_id);

-- received_at is UTC ISO 8601. Inbox mail from the last 30 days (up to 500 per account); starred ones are kept longer.
CREATE TABLE mail_messages (
  id           INTEGER PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  provider_id  TEXT NOT NULL,
  thread_id    TEXT,
  from_name    TEXT,
  from_address TEXT,
  subject      TEXT,
  snippet      TEXT,
  received_at  TEXT NOT NULL,
  unread       INTEGER NOT NULL DEFAULT 0,
  starred      INTEGER NOT NULL DEFAULT 0,
  web_link     TEXT,
  UNIQUE (account_id, provider_id)
);
CREATE INDEX mail_messages_account_received ON mail_messages(account_id, received_at);

-- A task made from a mail: the synced mail (while it's still synced) and a link to open it at the provider.
ALTER TABLE daily_tasks ADD COLUMN mail_message_id INTEGER REFERENCES mail_messages(id) ON DELETE SET NULL;
ALTER TABLE daily_tasks ADD COLUMN mail_link TEXT;
