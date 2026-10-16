import express from 'express';
import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { loadSession, requireJsonForWrites } from './auth/middleware.js';
import { createSessionStore } from './auth/sessions.js';
import { HttpError } from './http.js';
import { createJobs } from './jobs.js';
import { authRoutes } from './routes/auth.js';
import { dailyRoutes } from './routes/daily.js';
import { goalRoutes } from './routes/goals.js';
import { projectRoutes } from './routes/projects.js';
import { templateRoutes } from './routes/templates.js';

// Only this site's own files may load. Inline style attributes are allowed for progress bar widths.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/**
 * `now` is the clock (tests pass a fixed one). `jobs` runs the midnight rollover; index.js also starts its timer.
 */
export function createApp({ db, config, now = () => new Date(), jobs = createJobs(db, { now }) }) {
  const app = express();
  const sessions = createSessionStore(db, config);

  app.disable('x-powered-by');
  // Behind Caddy, trust one proxy hop so req.ip is the real client address.
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': CSP,
    });
    next();
  });

  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(requireJsonForWrites);
  api.use(express.json({ limit: '100kb' }));
  api.use(loadSession(sessions, config));
  // Before any logged-in request, make sure today's midnight rollover has run, so nothing is shown stale
  // (e.g. just after midnight, before the scheduler's next check). It's one indexed lookup once it has run.
  api.use((req, res, next) => {
    if (req.user) jobs.runDue();
    next();
  });

  api.get('/health', (req, res) => res.json({ ok: true }));
  api.use('/auth', authRoutes({ db, sessions, config }));
  api.use('/projects', projectRoutes({ db }));
  api.use('/templates', templateRoutes({ db }));
  api.use('/goals', goalRoutes({ db, now }));
  api.use(dailyRoutes({ db, now }));

  api.use((req, res) => res.status(404).json({ error: 'Not found' }));
  api.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  app.use('/api', api);

  // The built web app. Built file names change with every build, so /assets can be cached forever;
  // everything else (index.html, sw.js, the manifest) is checked with the server on every load.
  if (existsSync(config.webDir)) {
    app.use(
      express.static(config.webDir, {
        setHeaders(res, path) {
          const immutable = path.includes(`${sep}assets${sep}`);
          res.set('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
        },
      }),
    );
  }
  return app;
}
