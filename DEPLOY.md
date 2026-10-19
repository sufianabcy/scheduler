# Deploying Spidey Planner to AWS

You do these steps yourself. They take about 45 minutes, once. After that, every push to `main` deploys
automatically.

**What you end up with**

- One small ARM server (EC2 `t4g.micro`, 1 GB RAM) in Mumbai, running the app.
- `https://planner.duckdns.org` with a free certificate that renews itself.
- A nightly database backup on the server (7 days) and in S3 (30 days).
- GitHub Actions: on every push to `main` it runs the tests, builds, uploads and switches to the new version. If the
  new version doesn't start, the server keeps the old one.

> **About the name:** `planner.duckdns.org` is a short name and may already be taken on DuckDNS. If it is, pick
> another (for example `sufian-planner`) and use that name everywhere this guide says `planner.duckdns.org`.

Values used below. Write yours down as you create them:

| What                        | Example in this guide             | Yours |
|-----------------------------|-----------------------------------|-------|
| Web address                 | `planner.duckdns.org`             |       |
| Server IP (Elastic IP)      | `13.200.10.20`                    |       |
| Backup bucket               | `spidey-planner-backups-sufian`   |       |
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
| Name                   | `spidey-planner`                                                       |
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
**Associate Elastic IP address** → instance `spidey-planner` → **Associate**.

Write down this IP. It stays the same even if you stop and start the server.

## 3. Backups to S3 (10 min, optional but recommended)

### 3.1 The bucket

S3 → **Create bucket**:
- Name: something unique, e.g. `spidey-planner-backups-sufian` (S3 names are global).
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
      "Resource": "arn:aws:s3:::spidey-planner-backups-sufian/planner/*"
    }
  ]
}
```

→ **Next** → name `write-planner-backups` → **Create policy**.

EC2 → select `spidey-planner` → **Actions** → **Security** → **Modify IAM role** → `planner-backup` → **Update IAM role**.

The server can only add files under `planner/` in that bucket: it can't read, list or delete anything.

## 4. The web address (5 min)

1. Go to https://www.duckdns.org and sign in (GitHub or Google).
2. Under **domains**, type `planner` → **add domain**. (Taken? Pick another name.)
3. Put your Elastic IP in the **current ip** box next to it → **update ip**.

Check it from your Mac (it can take a minute):

```bash
dig +short planner.duckdns.org
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
sudo DOMAIN=planner.duckdns.org EMAIL=you@example.com BACKUP_BUCKET=spidey-planner-backups-sufian bash setup-server.sh planner_deploy.pub
```

It ends with a line like this. **Copy it** for the next step:

```
planner.duckdns.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...
```

Stay logged in to the server for step 7.

## 6. Connect GitHub (5 min)

GitHub → your repository `sufianabcy/scheduler` → **Settings** → **Secrets and variables** → **Actions** →
**New repository secret**. Add three:

| Name                 | Value                                                                    |
|----------------------|--------------------------------------------------------------------------|
| `DEPLOY_HOST`        | `planner.duckdns.org`                                                    |
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

- **Mac:** Chrome → `https://planner.duckdns.org` → log in → menu ⋮ → **Cast, save and share** →
  **Install page as app**. It appears in Launchpad and you can keep it in the Dock.
- **Android:** Chrome → `https://planner.duckdns.org` → log in → menu ⋮ → **Add to Home screen** → **Install**.
- On each device: **More → Notifications → Turn on**, then **Send a test**.

---

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
| Browser says the site can't be reached          | `dig +short planner.duckdns.org` shows your Elastic IP? Security group allows 80 and 443? |
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
