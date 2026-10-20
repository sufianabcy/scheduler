# Deploying Planner to AWS

The same guide as a doc you can open on your phone:
https://claude.ai/code/artifact/a6d64265-f475-46dc-9469-6b388ca57d69

You do these steps yourself. They take about 45 minutes, once. After that, every push to `main` deploys
automatically.

**What you end up with**

- One small ARM server (EC2 `t4g.micro`, 1 GB RAM) in Mumbai, running the app.
- `https://sufian-planner.duckdns.org` with a free certificate that renews itself.
- A nightly database backup on the server (7 days) and in S3 (30 days).
- GitHub Actions: on every push to `main` it runs the tests, builds, uploads and switches to the new version. If the
  new version doesn't start, the server keeps the old one.

Values used below. Write yours down as you create them:

| What                        | Example in this guide             | Yours |
|-----------------------------|-----------------------------------|-------|
| Web address                 | `sufian-planner.duckdns.org`      | `sufian-planner.duckdns.org` |
| Server IP (Elastic IP)      | `13.200.10.20`                    |       |
| Backup bucket               | `planner-backups-sufian`   |       |
| Your email                  | `you@example.com`                 |       |

---

## 1. Protect yourself from surprise bills (5 min)

Your account is on AWS's **Free plan** (accounts made after 15 July 2025): $100–200 in credits, for up to 6 months.

1. AWS console → search **Budgets** → **Create budget** → **Use a template** → **Monthly cost budget**.
   Amount `10` (USD), your email → **Create budget**. You get an email if spending heads past $10/month.
2. AWS console → **Billing and Cost Management** → **Credits**: note how much credit you have and when it ends.
3. **Before the 6 months are over**, upgrade to the Paid plan (in **Billing and Cost Management**, use **Upgrade plan**). On the Free plan,
   AWS pauses the account when the plan ends or the credits run out. The server would stop until you upgrade.

Expected cost: about **$10/month** (server ~$6, public IP ~$3.60, disk ~$1). Credits pay it while they last.

## 2. Create the server (10 min)

All in the AWS console. First, top right, set the region to **Asia Pacific (Mumbai) ap-south-1**.

If the region menu says **Global** and every region has a lock, you're on a page that isn't tied to a region
(Budgets, Billing, IAM). Type `EC2` in the search bar at the top and open it; the menu then lets you pick Mumbai.

### 2.1 A key to log in to the server

EC2 → **Key pairs** → **Create key pair**:
- Name `planner-admin`, type **ED25519**, format **.pem** → **Create**. The browser downloads `planner-admin.pem`.

On your Mac, move it into place:

```bash
mv ~/Downloads/planner-admin.pem ~/.ssh/ && chmod 400 ~/.ssh/planner-admin.pem
```

### 2.2 Launch the instance

EC2 → **Instances** → **Launch instances**:

| Setting                | Choose                                                                 |
|------------------------|------------------------------------------------------------------------|
| Name                   | `planner`                                                       |
| Application and OS     | **Ubuntu**, *Ubuntu Server 24.04 LTS*, architecture **64-bit (Arm)**   |
| Instance type          | **t4g.micro**                                                          |
| Key pair               | `planner-admin`                                                        |
| Network settings       | **Create security group**, tick **Allow SSH traffic from Anywhere**, **Allow HTTPS traffic from the internet**, **Allow HTTP traffic from the internet** |
| Storage                | **10** GiB, **gp3**                                                    |

→ **Launch instance**.

SSH has to be open to "Anywhere" so GitHub Actions can upload new versions. Only key logins are accepted
(Ubuntu turns password logins off), so that's safe. HTTP is only used to get the certificate and to redirect to
HTTPS.

### 2.3 A fixed IP address

EC2 → **Elastic IPs** → **Allocate Elastic IP address** → **Allocate**. Then select it → **Actions** →
**Associate Elastic IP address** → instance `planner` → **Associate**.

Write down this IP. It stays the same even if you stop and start the server.

## 3. Backups to S3 (10 min, optional but recommended)

### 3.1 The bucket

S3 → **Create bucket**:
- Name: something unique, e.g. `planner-backups-sufian` (S3 names are global).
- Region: Mumbai. Leave **Block all public access** on. → **Create bucket**.

Open the bucket → **Management** → **Create lifecycle rule**:
- Name `expire-30-days`, **Limit the scope** with prefix `planner/`.
- Tick **Expire current versions of objects**, `30` days → **Create rule**.

### 3.2 Let the server write to it

IAM → **Roles** → **Create role**:
- Trusted entity **AWS service**, use case **EC2** → **Next** → skip the policy list → **Next**.
- Name `planner-backup` → **Create role**.

Open the role → **Add permissions** → **Create inline policy** → **JSON**, paste (change the bucket name):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::planner-backups-sufian/planner/*"
    }
  ]
}
```

→ **Next** → name `write-planner-backups` → **Create policy**.

EC2 → select `planner` → **Actions** → **Security** → **Modify IAM role** → `planner-backup` → **Update IAM role**.

The server can only add files under `planner/` in that bucket: it can't read, list or delete anything.

## 4. The web address (5 min)

1. Go to https://www.duckdns.org and sign in (GitHub or Google).
2. Under **domains**, type `sufian-planner` → **add domain**.
3. Put your Elastic IP in the **current ip** box next to it → **update ip**.

Check it from your Mac (it can take a minute):

```bash
dig +short sufian-planner.duckdns.org
```

It should print your Elastic IP.

## 5. Set up the server (10 min)

On your Mac, in the project folder (`~/CodeFolder/Scheduler`).

**5.1** Make the key GitHub Actions will use to upload new versions:

```bash
ssh-keygen -t ed25519 -N "" -C planner-deploy -f ~/.ssh/planner_deploy
```

**5.2** Copy the setup script and that key's public half to the server (use your IP):

```bash
scp -i ~/.ssh/planner-admin.pem deploy/setup-server.sh ~/.ssh/planner_deploy.pub ubuntu@13.200.10.20:~
```

Type `yes` if it asks whether to trust the server.

**5.3** Log in to the server:

```bash
ssh -i ~/.ssh/planner-admin.pem ubuntu@13.200.10.20
```

**5.4** On the server, run the setup (use your address, email and bucket; leave `BACKUP_BUCKET=` empty if you
skipped step 3). It takes about 5 minutes:

```bash
sudo DOMAIN=sufian-planner.duckdns.org EMAIL=you@example.com BACKUP_BUCKET=planner-backups-sufian bash setup-server.sh planner_deploy.pub
```

It ends with a line like this. **Copy it** for the next step:

```
sufian-planner.duckdns.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...
```

Stay logged in to the server for step 7.

## 6. Connect GitHub (5 min)

GitHub → your repository `sufianabcy/scheduler` → **Settings** → **Secrets and variables** → **Actions** →
**New repository secret**. Add three:

| Name                 | Value                                                                    |
|----------------------|--------------------------------------------------------------------------|
| `DEPLOY_HOST`        | `sufian-planner.duckdns.org`                                                    |
| `DEPLOY_SSH_KEY`     | The whole private key. On your Mac run `pbcopy < ~/.ssh/planner_deploy`, then paste. It starts with `-----BEGIN OPENSSH PRIVATE KEY-----`. |
| `DEPLOY_KNOWN_HOSTS` | The line you copied at the end of step 5.4                               |

Then deploy for the first time: push the deploy files to `main` (see **Your git steps** in the chat, or below), or
if they're already pushed: **Actions** → **Test and deploy** → **Run workflow**.

Watch it in the **Actions** tab. A green tick means the server is running the new version.

## 7. Create your login (2 min)

On the server (still logged in from step 5):

```bash
sudo planner-user add you@example.com
```

It asks for a password twice (8+ characters). Repeat for the second person if needed. Then `exit`.

## 8. Open it and install it

- **Mac:** Chrome → `https://sufian-planner.duckdns.org` → log in → menu ⋮ → **Cast, save and share** →
  **Install page as app**. It appears in Launchpad and you can keep it in the Dock.
- **Android:** Chrome → `https://sufian-planner.duckdns.org` → log in → menu ⋮ → **Add to Home screen** → **Install**.
- On each device: **More → Notifications → Turn on**, then **Send a test**.

---

## Mail setup (Gmail and Outlook)

Mail stays switched off until the server has these settings. It takes about 45 minutes, once: two free app
registrations (Google and Microsoft, about 20 minutes each) and 5 minutes on the server. Do it after the Mail code
is deployed (pushed to `main`).

### Google (for every Gmail account)

1. Go to https://console.cloud.google.com and create a project called `Planner`.
2. **APIs & Services** → **Library** → search **Gmail API** → **Enable**.
3. **Google Auth Platform** → **Branding** (the two pages come with the app; deploy first):
   - App name `Planner`, your email as user support email. No logo (a logo makes Google review the app by hand).
   - **App domain**: home page `https://sufian-planner.duckdns.org/about.html`, privacy policy
     `https://sufian-planner.duckdns.org/privacy.html`
   - **Authorized domains**: **Add domain** → `sufian-planner.duckdns.org`
   - Developer contact: your email → **Save**

   **Audience**: user type **External**.
4. **Data access** → **Add or remove scopes** → paste `https://www.googleapis.com/auth/gmail.modify` →
   **Add to table** → **Update** → **Save**. (Read and star; it can't send mail.)
5. **Audience** → **Test users** → **Add users**: your Gmail addresses. This lets you connect Gmail straight away while
   Google checks the next step (in Testing, Google ends the connection every 7 days; the app shows **Reconnect**).
6. **Prove you own the address** (Google calls it "registered to you"):
   1. Open https://search.google.com/search-console with the same Google account → **Add property** → **Domain** →
      `sufian-planner.duckdns.org` → **Continue**. Copy the TXT record (`google-site-verification=…`). Leave the page open.
   2. On https://www.duckdns.org, copy your **token** (top of the page). In Terminal on your Mac, with both values
      filled in:
      ```bash
      curl "https://www.duckdns.org/update?domains=sufian-planner&token=YOUR-DUCKDNS-TOKEN&txt=google-site-verification=YOUR-CODE&verbose=true"
      ```
      It answers `OK`. Check with `dig +short TXT sufian-planner.duckdns.org` (can take a few minutes).
   3. Back in Search Console → **Verify**. Leave the TXT record in place afterwards.
7. Wait 24 hours (Google's rule after verifying a domain). Then **Branding** → the verification issues panel →
   **I have fixed the issues** → **Proceed**.
8. When Branding shows no issues: **Audience** → **Publish app** → **Confirm**. The status becomes **In production**:
   no more 7-day limit, and test users aren't needed any more. The Verification Center will still say "data access is
   not verified": leave it. That review (demo video, and a paid yearly security audit for Gmail access) is only for
   apps with more than 100 users. Don't submit it.
9. **Clients** → **Create client** → type **Web application**, name `Planner`. Under
   **Authorized redirect URIs** add both:
   - `https://sufian-planner.duckdns.org/api/mail/callback/google`
   - `http://localhost:3000/api/mail/callback/google` (only for trying it on your Mac)

   → **Create**. Copy the **Client ID** and **Client secret**.
10. When you connect Gmail in the app, Google shows "Google hasn't verified this app". That's expected for a personal
    app: click **Advanced** → **Go to Planner (unsafe)**, tick the box to allow Gmail access → **Continue**.

### Microsoft (Outlook.com, Hotmail and Microsoft 365)

1. Go to https://entra.microsoft.com and sign in with any Microsoft account. **App registrations** →
   **New registration**:
   - Name `Planner`
   - Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**
   - Redirect URI: platform **Web**, `https://sufian-planner.duckdns.org/api/mail/callback/microsoft`

   → **Register**. Copy the **Application (client) ID** from the Overview page.
2. **Authentication** → **Add URI**: `http://localhost:3000/api/mail/callback/microsoft` (only for your Mac) → **Save**.
3. **Certificates & secrets** → **New client secret** → 24 months → copy the **Value** (not the Secret ID).
   Add a task in the app for a week before it expires: Outlook stops syncing on that day.
4. **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated**: `offline_access`, `User.Read`,
   `Mail.ReadWrite` → **Add permissions**. (Read and flag; it can't send mail.)

A work or school Microsoft 365 account may say "Need admin approval": only its IT team can allow it.

### Put the settings on the server

Log in to the server:

```bash
ssh -i ~/.ssh/planner-admin.pem ubuntu@sufian-planner.duckdns.org
```

Add the app's address and a new encryption key (each line only adds what's missing):

```bash
sudo grep -q '^PUBLIC_URL=' /etc/planner.env || echo "PUBLIC_URL=https://sufian-planner.duckdns.org" | sudo tee -a /etc/planner.env
```

```bash
sudo grep -q '^MAIL_TOKEN_KEY=.' /etc/planner.env || echo "MAIL_TOKEN_KEY=$(openssl rand -base64 32)" | sudo tee -a /etc/planner.env >/dev/null
```

Open the settings file and add (or fill in) these four lines with what you copied:

```bash
sudo nano /etc/planner.env
```

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
MS_CLIENT_ID=...
MS_CLIENT_SECRET=...
```

Save with **Ctrl+O**, **Enter**, then **Ctrl+X**. Restart the app:

```bash
sudo systemctl restart planner
```

Keep a copy of the key in your password manager (`sudo grep MAIL_TOKEN_KEY /etc/planner.env`). It isn't in the
backups on purpose. If it's ever lost, connect the accounts again.

### Connect your accounts

In the app: **Mail** → **Connect Gmail** / **Connect Outlook** (or **More** → **Mail accounts**). You sign in on
Google's or Microsoft's own page and come back to the app. The first sync takes a few seconds.

### Try it on your Mac first (optional)

Put the same settings in `server/.env` with `PUBLIC_URL=http://localhost:3000`, then
`npm --prefix web run build && npm --prefix server start`. Open exactly **http://localhost:3000**: Google and
Microsoft only send you back to that address, and the login cookie for `127.0.0.1` is a different one.

### If connecting doesn't work

| Message                                             | Fix                                                                 |
|-----------------------------------------------------|---------------------------------------------------------------------|
| Google: `redirect_uri_mismatch`                     | The redirect URI in Google step 9 must match exactly, `https` and all |
| Microsoft: `AADSTS50011`                            | Same, under Authentication                                          |
| Google: "Access blocked" / `access_denied`          | Add the address as a test user (Google step 5), or publish (step 8) |
| "Gmail is not set up on the server yet"             | The client ID or secret is missing in `/etc/planner.env`; restart after adding |
| An account says "Needs reconnecting"                | Tap **Reconnect** (password changed, access removed, or the 7-day Testing limit) |

## LMS setup (KL University)

The app signs in to lms.kluniversity.in the way the Moodle phone app does and keeps only the sign-in token,
encrypted with `LMS_TOKEN_KEY`. Your LMS password is never stored. On the server, add the key once (this only adds it
if it's missing), then restart:

```bash
sudo grep -q '^LMS_TOKEN_KEY=.' /etc/planner.env || echo "LMS_TOKEN_KEY=$(openssl rand -base64 32)" | sudo tee -a /etc/planner.env >/dev/null
```

```bash
sudo systemctl restart planner
```

Keep a copy of the key in your password manager (`sudo grep LMS_TOKEN_KEY /etc/planner.env`). If it's lost or
changed, the app asks you to connect the LMS again; nothing else is lost. Then in the app: More → LMS → type your LMS
username and password → Connect LMS.

On your Mac, `server/.env` already has its own `LMS_TOKEN_KEY` (it's gitignored).

## Everyday use

All commands below run on the server (`ssh -i ~/.ssh/planner-admin.pem ubuntu@13.200.10.20`).

| To…                              | Run                                                        |
|----------------------------------|------------------------------------------------------------|
| Deploy a new version             | Push to `main` on GitHub (nothing to do on the server)     |
| See if the app is running        | `systemctl status planner`                                 |
| Watch the app's log              | `journalctl -u planner -f`                                 |
| Check HTTPS/certificate problems | `journalctl -u caddy -n 50`                                |
| List logins                      | `sudo planner-user list`                                   |
| Change a password                | `sudo planner-user passwd you@example.com`                 |
| Remove a login and its data      | `sudo planner-user remove someone@example.com --yes`       |
| Let a login create accounts in the app (admin) | `sudo planner-user admin you@example.com` (`unadmin` takes it away) |
| Back up right now                | `sudo systemctl start planner-backup`                      |
| See backups on the server        | `sudo ls -l /var/lib/planner/backups`                      |
| See backups in S3                | S3 console → your bucket → `planner/`                      |

### Go back to an earlier version

The server keeps the last 5 versions.

```bash
ls -t /opt/planner/releases
sudo -u deploy ln -sfn /opt/planner/releases/<id-from-the-list> /opt/planner/current
sudo systemctl restart planner
```

The next push to `main` deploys the newest code again.

### Restore a backup

This replaces all current data with the backup's.

```bash
sudo systemctl stop planner
sudo -u planner bash -c 'cd /var/lib/planner && mv planner.db planner.db.before-restore && rm -f planner.db-wal planner.db-shm'
sudo -u planner bash -c 'gunzip -c /var/lib/planner/backups/planner-2026-10-19.db.gz > /var/lib/planner/planner.db'
sudo systemctl start planner
```

To restore from S3 instead, download the file in the S3 console, copy it to the server with `scp`, and use that file
in the `gunzip` line.

### If something goes wrong

| Problem                                          | Look at                                                                 |
|--------------------------------------------------|-------------------------------------------------------------------------|
| Browser says the site can't be reached          | `dig +short sufian-planner.duckdns.org` shows your Elastic IP? Security group allows 80 and 443? |
| Certificate error                                | `journalctl -u caddy -n 50`. Caddy needs the address pointing at the server and port 80 open. |
| GitHub Actions fails at "Deploy" with ssh errors | The three secrets: no extra spaces, the whole private key, the known-hosts line from step 5.4. |
| GitHub Actions says "did not start"              | `journalctl -u planner -n 50` on the server. The previous version keeps running. |
| Notifications don't arrive                       | More → Notifications → Send a test. On a Mac, allow Chrome in System Settings → Notifications. |

### What the setup made

| Path                          | What                                                                  |
|-------------------------------|-----------------------------------------------------------------------|
| `/opt/planner/releases/<id>`  | Uploaded versions (owned by the `deploy` user)                         |
| `/opt/planner/current`        | Link to the version that's running                                     |
| `/var/lib/planner/planner.db` | The database (owned by the `planner` user, which runs the app)         |
| `/var/lib/planner/backups`    | Nightly backups, 03:30 IST, kept 7 days                                |
| `/etc/planner.env`            | Settings: port, database path, HTTPS cookie, backup bucket, push contact |
| `/etc/caddy/Caddyfile`        | HTTPS for your address                                                 |
| `/usr/local/bin/planner-user` | The login management command                                           |

The `deploy` user (the one GitHub Actions logs in as) can upload versions and restart the app, nothing else.
