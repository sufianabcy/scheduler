-- Server-wide settings, e.g. the push notification (VAPID) keys created on first start.
CREATE TABLE app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
