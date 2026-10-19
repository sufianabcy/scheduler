import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { createJobs } from './jobs.js';
import { createMail } from './mail/index.js';
import { createNotifier } from './notifications.js';
import { createPush, loadVapidKeys } from './push.js';

const db = openDb(config.dbPath);
const push = createPush(db, { vapid: loadVapidKeys(db), subject: config.vapidSubject });
const mail = createMail(db, { config });
const jobs = createJobs(db, { notifier: createNotifier(db, { push, mail }), mail });
const app = createApp({ db, config, jobs, push, mail });
const stopJobs = jobs.start();

const server = app.listen(config.port, config.host, () => {
  console.log(`Planner API on http://${config.host}:${config.port} (db: ${config.dbPath})`);
});

function shutdown() {
  stopJobs();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
