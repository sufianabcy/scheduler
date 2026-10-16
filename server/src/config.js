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
  sessionDays: 30,
};
