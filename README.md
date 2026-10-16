# Spidey Planner

Daily planner with monthly goals and step-by-step projects, installed as an app from Chrome on Android and Mac.
See [SPEC.md](SPEC.md) for what it does and how it's built.

## Status

| Step | What                                              | State   |
|------|---------------------------------------------------|---------|
| 1    | Backend skeleton, login, database tables          | Done    |
| 2    | Projects and monthly goals                        | Done    |
| 3    | Daily plan, repeating tasks, Unfinished, clean-up | Done    |
| 4    | Screens and app install                           | Next    |
| 5    | Push notifications                                | To do   |
| 6    | AWS, HTTPS, backups, auto-deploy                  | To do   |
| 7    | Spider-Man design pass                            | To do   |

## Run the server locally

Needs Node 24 or newer. It uses Node's built-in SQLite, so there is no database to install.

```bash
cd server
npm install
npm run user -- add you@example.com   # asks for a password (8+ characters)
npm run dev                           # http://127.0.0.1:3000, restarts on code changes
```

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
cd server
npm test
```

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
| POST   | `/api/days/:day/tasks`   | `{ title }`; today or later only                                             |
| PUT    | `/api/days/:day/order`   | `{ taskIds }`: new order of all of that day's tasks                          |
| PATCH  | `/api/tasks/:id`         | `{ title?, done? }` or `{ title?, day? }` to move it (not repeating tasks)   |
| DELETE | `/api/tasks/:id`         | A repeating task deleted from a day stays off that day                       |
| GET    | `/api/unfinished`        |                                                                              |

Ticking a task from the Unfinished list moves it to today as done.

### Repeating tasks

| Method | Path                 | Body / notes                                                    |
|--------|----------------------|-----------------------------------------------------------------|
| GET    | `/api/repeating`     |                                                                 |
| POST   | `/api/repeating`     | `{ title, weekdays: ['mon', 'tue', …] }`                        |
| PATCH  | `/api/repeating/:id` | `{ title?, weekdays?, active? }`; changes today and later days only |
| DELETE | `/api/repeating/:id` | Removes it from today on; past days keep their copies           |

### Midnight rollover

Runs once per IST day for all users, just after midnight (the server checks every minute and before each
logged-in request, so it catches up if the server was off):

1. Open tasks from earlier days → Unfinished (repeating ones → missed).
2. Unfinished monthly-goal tasks whose date passed → moved to today.
3. Finished and missed daily tasks from before this week (Monday) → deleted.
4. Goals from earlier months → deleted if fully finished, otherwise moved to this month (`carriedFrom` keeps the
   month they first came from).
