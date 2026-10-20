import { fileURLToPath } from 'node:url';

const bool = (value) => value === 'true' || value === '1';

export const config = {
  // 127.0.0.1 keeps the server reachable only from this machine; Caddy forwards outside traffic to it.
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? './data/planner.db',
  // The built web app (web/dist). The server serves it, so the whole app is one process.
  webDir: process.env.WEB_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url)),
  cookieSecure: bool(process.env.COOKIE_SECURE),
  trustProxy: bool(process.env.TRUST_PROXY),
  timeZone: 'Asia/Kolkata',
  // Contact for the push services (required by the Web Push standard): a mailto: or https: URL.
  vapidSubject: process.env.VAPID_SUBJECT ?? 'mailto:planner@example.com',
  sessionDays: 30,
  // Mail (Gmail and Outlook). Switched off until MAIL_TOKEN_KEY is set; each provider until its ID and secret are set.
  mail: {
    tokenKey: process.env.MAIL_TOKEN_KEY,
    // The address people open the app at; the providers send the browser back to <publicUrl>/api/mail/callback/...
    publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, ''),
    google: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET },
    microsoft: { clientId: process.env.MS_CLIENT_ID, clientSecret: process.env.MS_CLIENT_SECRET },
  },
  // KL University LMS (Moodle). Switched off until LMS_TOKEN_KEY is set.
  lms: {
    tokenKey: process.env.LMS_TOKEN_KEY,
    url: (process.env.LMS_URL ?? 'https://lms.kluniversity.in').replace(/\/$/, ''),
  },
};
