# Spidey Planner

Daily planner with monthly goals and step-by-step projects, installed as an app from Chrome on Android and Mac.
See [SPEC.md](SPEC.md) for what it does and how it's built.

## Status

| Step | What                                              | State   |
|------|---------------------------------------------------|---------|
| 1    | Backend skeleton, login, database tables          | Done    |
| 2    | Projects and monthly goals                        | Next    |
| 3    | Daily plan, repeating tasks, Unfinished, clean-up | To do   |
| 4    | Screens and app install                           | To do   |
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

All requests that change something must be sent as `application/json`.

| Method | Path               | Notes                                                       |
|--------|--------------------|-------------------------------------------------------------|
| GET    | `/api/health`      | `{ ok: true }`                                              |
| POST   | `/api/auth/login`  | `{ email, password }` → sets the `sp_session` cookie (30 days) |
| POST   | `/api/auth/logout` | Ends the session                                            |
| GET    | `/api/auth/me`     | `{ user: { id, email } }`, or 401                           |

10 failed logins in 15 minutes (per IP address or per email) blocks login for the rest of that window.
