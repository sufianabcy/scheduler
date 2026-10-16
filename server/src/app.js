import express from 'express';
import { loadSession, requireJsonForWrites } from './auth/middleware.js';
import { createSessionStore } from './auth/sessions.js';
import { HttpError } from './http.js';
import { authRoutes } from './routes/auth.js';
import { goalRoutes } from './routes/goals.js';
import { projectRoutes } from './routes/projects.js';
import { templateRoutes } from './routes/templates.js';

export function createApp({ db, config }) {
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

  api.get('/health', (req, res) => res.json({ ok: true }));
  api.use('/auth', authRoutes({ db, sessions, config }));
  api.use('/projects', projectRoutes({ db }));
  api.use('/templates', templateRoutes({ db }));
  api.use('/goals', goalRoutes({ db }));

  api.use((req, res) => res.status(404).json({ error: 'Not found' }));
  api.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  app.use('/api', api);
  return app;
}
