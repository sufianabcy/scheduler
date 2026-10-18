# Spidey Planner

Daily planner with monthly goals and step-by-step projects, installed as an app from Chrome on Android and Mac.
See [SPEC.md](SPEC.md) for what it does and how it's built.

## Status

| Step | What                                              | State   |
|------|---------------------------------------------------|---------|
| 1    | Backend skeleton, login, database tables          | Done    |
| 2    | Projects and monthly goals                        | Done    |
| 3    | Daily plan, repeating tasks, Unfinished, clean-up | Done    |
| 4    | Screens and app install                           | Done    |
| 5    | Push notifications                                | Done    |
| 6    | AWS, HTTPS, backups, auto-deploy                  | Next    |
| 7    | Spider-Man design pass                            | Done (two rounds) |

## Run it locally

Needs Node 24 or newer. The server uses Node's built-in SQLite, so there is no database to install.

```bash
cd server && npm install && cd ../web && npm install && cd ..
npm --prefix server run user -- add you@example.com   # asks for a password (8+ characters)
```

**While changing code** (two terminals; the web app reloads on save):

```bash
npm --prefix server run dev
```

```bash
npm --prefix web run dev
```

Then open http://localhost:5173. Vite forwards `/api` to the server on port 3000.

**The way it runs in production** (one process serving both the app and the API):

```bash
npm --prefix web run build && npm --prefix server start
```

Then open http://127.0.0.1:3000. On a Mac, Chrome can install it from there (menu ⋮ → Cast, save and share →
Install page as app). Installing on an Android phone needs HTTPS, so that comes with the AWS deploy (step 6).

Optional: copy `server/.env.example` to `server/.env` to change the port or database path.
The database file is `server/data/planner.db` by default.

## Manage accounts

There is no sign-up page. Accounts are managed on the server:

```bash
npm run user -- add <email>            # create (asks for password twice)
npm run user -- passwd <email>         # new password; logs that user out on every device
npm run user -- list
npm run user -- remove <email> --yes   # deletes the user and ALL of their data
```

## Tests

```bash
npm --prefix server test
```

```bash
npm --prefix web test
```

The web tests cover quick add (`web/src/quickadd.js`).

## Web app

`web/` is Preact + Vite in plain JavaScript (about 15 KB of script after compression). Screens:

| Screen   | Route                     | What it does                                                      |
|----------|---------------------------|-------------------------------------------------------------------|
| Today    | `#/`                      | Today's checklist, dated goal tasks, Unfinished list, goal and project cards |
| Plan     | `#/plan`, `#/plan/<day>`  | Any day's checklist; opens on tomorrow from 6 PM                  |
| Goals    | `#/goals`, `#/goals/<id>` | Monthly goals by month; ordered tasks with optional dates         |
| Projects | `#/projects`, `#/projects/<id>` | Steps that unlock one by one, checklists, templates         |
| More     | `#/more`                  | Repeating tasks, templates, theme, log out                        |

- Look: Spider-Man night poster. Colours, fonts, the type scale and sizes are tokens in `web/src/theme.css`;
  every text rule in `web/src/app.css` is one of four roles (Display, Label, Body, Meta).
- Fonts: Barlow and Barlow Condensed, self-hosted in `web/src/assets/fonts/` (SIL OFL, see `OFL.txt`), trimmed to
  Basic Latin plus the punctuation the app uses.
- Every page opens with a poster header band (`PageHeader` in `web/src/components/ui.jsx`) using the two photos in
  `web/src/assets/hero/`. Today is two columns from 1000px wide.
- Production build, gzipped: JS 22.3 KB, CSS 4.8 KB. Fonts 31.8 KB and header images 35.1 KB, cached by the
  service worker after the first load. No idle animations, no new dependencies. Lighthouse not measured yet.
- `web/public/sw.js` makes the app installable and lets it open offline with the last data it loaded. Changes
  need the network. Logging out deletes the saved data.
- App icons (red mask with lens eyes) are drawn by `web/scripts/make_icons.py` (`npm --prefix web run icons`, needs
  Pillow). After changing them, bump `SHELL` in `web/public/sw.js`.

## API so far

All requests that change something must be sent as `application/json`. Everything except `/api/health` and
`/api/auth/login` needs the login cookie. Changes to a project or goal answer with the whole updated project or goal.

### Login

| Method | Path               | Notes                                                          |
|--------|--------------------|----------------------------------------------------------------|
| GET    | `/api/health`      | `{ ok: true }`                                                 |
| POST   | `/api/auth/login`  | `{ email, password }` → sets the `sp_session` cookie (30 days) |
| POST   | `/api/auth/logout` | Ends the session                                               |
| GET    | `/api/auth/me`     | `{ user: { id, email } }`, or 401                              |

10 failed logins in 15 minutes (per IP address or per email) blocks login for the rest of that window.

### Projects (general goals)

Steps are done in order. Each step's `state` is `done`, `current` (the only one you can finish or tick) or `locked`.

| Method | Path                                            | Body / notes                                              |
|--------|-------------------------------------------------|-----------------------------------------------------------|
| GET    | `/api/projects`                                 | Cards: progress, current step                             |
| POST   | `/api/projects`                                 | `{ title, steps?: [{ title, items? }] }` or `{ title, templateId }` |
| GET    | `/api/projects/:id`                             | Full project with steps and checklists                    |
| PATCH  | `/api/projects/:id`                             | `{ title }`                                               |
| DELETE | `/api/projects/:id`                             |                                                           |
| POST   | `/api/projects/:id/steps`                       | `{ title, items?, beforeStepId? }` (default: at the end)  |
| PUT    | `/api/projects/:id/steps/order`                 | `{ stepIds }`: new order of all unfinished steps          |
| PATCH  | `/api/projects/:id/steps/:stepId`               | `{ title }`                                               |
| DELETE | `/api/projects/:id/steps/:stepId`               | Unfinished steps only                                     |
| POST   | `/api/projects/:id/steps/:stepId/finish`        | Current step only; ticks its remaining checklist          |
| POST   | `/api/projects/:id/steps/:stepId/reopen`        | Last finished step only                                   |
| POST   | `/api/projects/:id/steps/:stepId/items`         | `{ title }`                                               |
| PATCH  | `/api/projects/:id/steps/:stepId/items/:itemId` | `{ title?, done? }`; ticking only on the current step     |
| DELETE | `/api/projects/:id/steps/:stepId/items/:itemId` |                                                           |

Progress: each step is an equal share; the current step adds the ticked part of its checklist (rounded down).

### Templates

| Method | Path                 | Body / notes                                                   |
|--------|----------------------|----------------------------------------------------------------|
| GET    | `/api/templates`     |                                                                |
| POST   | `/api/templates`     | `{ name, steps: [{ title, items? }] }` or `{ name, fromProjectId }` |
| GET    | `/api/templates/:id` |                                                                |
| DELETE | `/api/templates/:id` |                                                                |

### Monthly goals

Tasks follow the same order and lock rules as project steps. Progress = finished tasks / all tasks.

| Method | Path                                    | Body / notes                                        |
|--------|-----------------------------------------|-----------------------------------------------------|
| GET    | `/api/goals?month=YYYY-MM`              | Default: this month (IST)                           |
| POST   | `/api/goals`                            | `{ title, month?, tasks?: [{ title, dueDay? }] }`   |
| GET    | `/api/goals/:id`                        |                                                     |
| PATCH  | `/api/goals/:id`                        | `{ title }`                                         |
| DELETE | `/api/goals/:id`                        |                                                     |
| POST   | `/api/goals/:id/tasks`                  | `{ title, dueDay?, beforeTaskId? }`                 |
| PUT    | `/api/goals/:id/tasks/order`            | `{ taskIds }`: new order of all unfinished tasks    |
| PATCH  | `/api/goals/:id/tasks/:taskId`          | `{ title?, dueDay? }`; `dueDay: null` removes the date |
| DELETE | `/api/goals/:id/tasks/:taskId`          | Unfinished tasks only                               |
| POST   | `/api/goals/:id/tasks/:taskId/finish`   | Current task only                                   |
| POST   | `/api/goals/:id/tasks/:taskId/reopen`   | Last finished task only                             |

### Daily plan

Days are `YYYY-MM-DD` in IST. A task's `status` is `open`, `done`, `unfinished` (not done by midnight; shown in the
Unfinished list) or `missed` (a repeating task that wasn't done).

| Method | Path                     | Body / notes                                                                 |
|--------|--------------------------|------------------------------------------------------------------------------|
| GET    | `/api/today`             | Home page: today's tasks, Unfinished list, goal tasks due, goal and project cards |
| GET    | `/api/days/:day`         | That day's checklist (adds repeating tasks for today and later days)         |
| POST   | `/api/days/:day/tasks`   | `{ title, repeat?, remindAt?, priority? }`; today or later. Answers `{ tasks, firstDay }` |
| PUT    | `/api/days/:day/order`   | `{ taskIds }`: new order of all of that day's tasks                          |
| PATCH  | `/api/tasks/:id`         | `{ title?, done?, day?, repeat?, remindAt?, priority? }`; `done` and `day` not together |
| DELETE | `/api/tasks/:id`         | A repeating task deleted from a day stays off that day                       |
| GET    | `/api/unfinished`        |                                                                              |

Ticking a task from the Unfinished list moves it to today as done.

### Repeating tasks

| Method | Path                 | Body / notes                                                    |
|--------|----------------------|-----------------------------------------------------------------|
| GET    | `/api/repeating`     |                                                                 |
| POST   | `/api/repeating`     | `{ title, repeat, startDay?, remindAt? }` or `{ title, weekdays }` |
| PATCH  | `/api/repeating/:id` | `{ title?, repeat?, weekdays?, active?, remindAt? }`; today and later only |
| DELETE | `/api/repeating/:id` | Removes it from today on; past days keep their copies           |

`repeat` works like Google Tasks: `{ freq: 'daily' | 'weekly' | 'monthly', every: 1–99, weekdays: ['mon', …],
until: 'YYYY-MM-DD' | null }`. Weekly with no weekdays repeats on the start day's weekday; monthly on the 31st falls on
the last day of shorter months. `repeat: null` on a repeating task stops it (that day's copy stays as a one-off).
Changing the title, repeat or reminder of a repeating task changes it and its upcoming copies; past days stay as they
were. `remindAt` is `'HH:MM'` (IST) or `null`. `priority` is 1 (highest), 2, 3 or `null`; a day lists P1 first,
then P2, P3, then the rest, each in the order you set.

**Quick add** (in the app, before anything is sent): one typed line can carry the day, reminder, repeat and priority,
e.g. `gym tomorrow 7am every mon wed p1`. It understands today / tomorrow / tonight / day after tomorrow / in 3 days /
next week / a weekday / `25 oct` / `oct 25` / `25/10` (day first); `7am`, `7:30pm`, `19:00`, `at 5` (1–6 means PM),
`noon`; `daily`, `every weekday`, `every mon wed`, `every 2 weeks`, `every other day`, `monthly`; and `p1`–`p3`.
The app shows what it understood before adding, with a "Keep text as typed" link.

### Midnight rollover

Runs once per IST day for all users, just after midnight (the server checks every minute and before each
logged-in request, so it catches up if the server was off):

1. Open tasks from earlier days → Unfinished (repeating ones → missed).
2. Unfinished monthly-goal tasks whose date passed → moved to today.
3. Finished and missed daily tasks from before this week (Monday) → deleted.
4. Goals from earlier months → deleted if fully finished, otherwise moved to this month (`carriedFrom` keeps the
   month they first came from).

### Notifications

| Method | Path                    | Body / notes                                              |
|--------|-------------------------|-----------------------------------------------------------|
| GET    | `/api/push`             | `{ publicKey, devices }`                                  |
| POST   | `/api/push/subscribe`   | The browser's `PushSubscription` JSON                     |
| POST   | `/api/push/unsubscribe` | `{ endpoint }`                                            |
| POST   | `/api/push/test`        | Sends a test notification to all of your devices          |

| GET    | `/api/settings/notifications` | `{ eveningReminder: { on, time }, morningSummary: { on, time } }` |
| PATCH  | `/api/settings/notifications` | Any part of the above. Evening 12:00–23:59, morning 00:00–12:00   |

Sent to every device that turned notifications on (More → Notifications), in IST, at times each user picks:

- **Plan-tomorrow reminder** (default 23:00). Skipped if you already added tasks for tomorrow.
- **Today's plan** (default 06:00): "Today: N tasks", the first three, and how many are in Unfinished.
- **Task reminders**: at the time set on a task, while it's still open. Repeating tasks remind on every copy.

Each is sent once. If the server was down at that moment it still sends a little later (plan-tomorrow up to 59
minutes, today's plan up to 2 h 59 min, task reminders up to 15 minutes), never later. The server makes its push keys
(VAPID) on first start and keeps them in the database; see `server/.env.example`.

To try it before deploying: start the app either way (see "Run it locally") and open it in Chrome on this computer
at http://localhost:5173 (dev) or http://127.0.0.1:3000 (built). Chrome asks to allow notifications when you log in,
from the banner on Today, or when you switch on a reminder. More → Notifications → "Send a test" sends one, and
"Check this device" shows which step is missing if nothing arrives.

Chrome only allows notifications on https:// addresses and on localhost. Opening the app on a phone over Wi-Fi
(http://192.168…) can't show notifications until it's online with https (step 6). For testing before that, add the
address in the phone's chrome://flags → "Insecure origins treated as secure".
