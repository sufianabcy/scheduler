import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { createJobs } from './jobs.js';

const db = openDb(config.dbPath);
const jobs = createJobs(db);
const app = createApp({ db, config, jobs });
const stopJobs = jobs.start();

const server = app.listen(config.port, config.host, () => {
  console.log(`Spidey Planner API on http://${config.host}:${config.port} (db: ${config.dbPath})`);
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
