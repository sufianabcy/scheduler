# Spidey Planner: spec v0.2

A light daily planner with monthly goals and step-by-step projects. Installed from Chrome on an Android phone
(home-screen icon) and on a Mac (Dock icon). Hosted on AWS, Mumbai region (ap-south-1).

Status: draft, updated 2026-10-16. Items marked **(assumed)** still need your confirmation.

---

## 1. Users and login

- At most 2 users. Each user has their own separate data.
- Email + password login. There is no sign-up page: accounts are created with a command on the server.
- Passwords are stored as scrypt hashes (built into Node, so no extra package).
- You stay logged in for 30 days. Using the app pushes that forward, so you stay logged in as long as you open it
  at least once a month.
- 10 failed logins in 15 minutes blocks login for the rest of that window.

## 2. Daily plan

- Each day has a plain checklist. Tasks have no start times (only optional reminders).
- Any task can repeat, set when adding or editing it (like Google Tasks): daily, every weekday, weekly on chosen
  days, monthly, or custom (every N days/weeks/months, optionally until a date). Copies are added automatically.
- Any task can have a reminder at a chosen time; repeating tasks remind on every copy.
- Any task can have a priority (P1–P3); a day lists P1 first.
- Quick add: one typed line like "gym tomorrow 7am every mon wed p1" sets the day, reminder, repeat and priority.
- Today's view also shows:
  - monthly-goal tasks that have a date set for today
  - the current open step of each project and monthly goal

### Unfinished tasks

- At midnight, any daily task that isn't ticked moves to an **Unfinished** list. It does not go into the next day.
- The Unfinished list is shown on the home page. From there you can tick a task, move it to a day, or delete it.
- Ticking a task in the Unfinished list moves it to today as done, so it shows on the day you finished it.
- Unfinished tasks stay there until you deal with them.
- Deleting a repeating task from one day removes it from that day only.
- A missed repeating task (e.g. daily gym) does **not** go to Unfinished. It just counts as missed for that day.
  **(assumed)**

### Notifications (IST)

Each user picks the times (More → Notifications) and can turn either one off.

| Default | Message                                               | Rule                                              |
|---------|-------------------------------------------------------|---------------------------------------------------|
| 23:00   | "Plan tomorrow"                                       | Skipped if tomorrow already has tasks you added   |
| 06:00   | "Today: N tasks", the first few, and unfinished count | Always sent while on                              |
| per task | The task's title                                     | At the task's reminder time, while it's still open |

## 3. Monthly goals

- A goal belongs to a month and holds an ordered list of tasks.
- The tasks are locked in order, like project steps: only the first unfinished task is open.
- Tasks usually have no date. You can optionally give a task a date. If a dated task isn't done that day, it moves to
  the next day.
- Progress % = finished tasks / all tasks.
- At the end of the month, unfinished goals move to the next month automatically and show "carried from <month>".

## 4. General goals (projects)

- A project is an ordered list of steps, e.g. Design → Backend → Frontend → Deploy.
- Only the first unfinished step is open. Finishing it opens the next one. Later steps are shown locked.
- Each step can have its own checklist.
- Progress: each step is an equal share. The current step adds part of its share based on its checklist.
  Example: 4 steps, step 1 done, step 2 has 2 of 4 checklist items done → (1 + 0.5) / 4 = 37.5%.
- No deadlines.
- Steps that aren't finished yet can be reordered, inserted, edited or deleted.
- Templates: you can save a project's step list as a template and start new projects from it.

## 5. Clean-up of finished tasks

| What                       | Shown                    | Deleted                                                     |
|----------------------------|--------------------------|-------------------------------------------------------------|
| Finished daily task        | Only on its own day      | When its week ends (Sunday night, IST) **(assumed: calendar week Mon–Sun)** |
| Finished monthly-goal task | Inside its goal          | At month end, together with goals that are fully done        |
| Unfinished goal at month end | Moves to next month    | Its finished tasks move with it, so its progress % stays right **(assumed)** |
| Projects                   | Always                   | Only when you delete them                                   |

The clean-up runs right after midnight IST. The server checks every minute and before every request, and catches up
if it was off at midnight.

## 6. Home page

- Today's checklist, at the top
- Unfinished tasks (only shown when there are any)
- Monthly goal cards, each with a progress bar and the current task
- Project cards, each with a progress bar and the current step's name

## 7. Design

- Spider-Man theme. Dark by default, with a light mode switch.
- Small CSS-only animations, e.g. a web-shot when you finish a task.
- You'll share reference images after the app is working. All colours and fonts are kept in one theme file, so
  restyling later is quick.
- The app uses original web and spider motifs, not official Marvel artwork.

## 8. Tech (chosen for lowest memory and size)

| Part           | Choice                                                                                   |
|----------------|------------------------------------------------------------------------------------------|
| Backend        | Node.js 24 + Express 5, JavaScript. Measured at about 85 MB of RAM (Spring Boot needs ~300 MB) |
| Database       | SQLite built into Node 24 (`node:sqlite`): a single file, no database service or package |
| Scheduled jobs | A one-minute timer inside the server (no package): midnight clean-up now, 23:00 and 06:00 in step 5 |
| Push           | Web Push with VAPID keys (`web-push` library), so no Firebase account is needed          |
| Frontend       | Preact + Vite, JavaScript. Same code style as React, but about 3 KB instead of ~45 KB     |
| Offline        | Today's plan and goals can be viewed offline. Changes need internet                      |
| Packaging      | The built frontend is served by the Node server, so the whole app is one process         |
| HTTPS          | Caddy reverse proxy with an automatic free Let's Encrypt certificate                     |

## 9. Hosting and cost

- **Server:** with Node + SQLite, a 512 MB server is enough.
  - EC2 `t3.micro` if the account is in its 12-month free tier.
  - Otherwise Lightsail 512 MB, $5/month including the public IP address.
- **Domain:** free DuckDNS subdomain. **(name to be picked)**
- **Backups:** nightly copy of the SQLite file to S3, kept for 30 days.
- **Deploys:** code on GitHub. Each push to `main` makes GitHub Actions copy the new build to the server and restart
  it.

| Item                | EC2 free tier | After free tier (EC2) | Lightsail 512 MB |
|---------------------|---------------|-----------------------|------------------|
| Server              | $0            | ~$7.5                 | $5 (IP and disk included) |
| Public IPv4         | $0            | ~$3.6                 | included         |
| Disk                | $0            | ~$0.7                 | included         |
| S3 backups          | ~$0           | ~$0.05                | ~$0.05           |
| **Total per month** | **~$0**       | **~$12**              | **~$5**          |

## 10. Build order

1. Backend skeleton, login, database tables
2. Projects and monthly goals (locked order, checklists, templates)
3. Daily plan, repeating tasks, Unfinished list, clean-up job
4. Screens and app install on phone and Mac
5. Push notifications at 23:00 and 06:00
6. AWS server, HTTPS, backups, GitHub auto-deploy
7. Spider-Man design pass with your references

## 11. Open questions

1. When was the AWS account created: before or after 15 July 2025? This decides EC2 free tier vs Lightsail.
   Only needed at step 6.
2. What web address do you want, e.g. `spidey-planner.duckdns.org`? Only needed at step 6.
3. Check the **(assumed)** items above: missed repeating tasks, the calendar week, and carried goals keeping their
   finished tasks.
