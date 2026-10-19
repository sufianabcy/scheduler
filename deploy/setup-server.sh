#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 server for Planner. Safe to run again.
#
# Usage (on the server, as the default "ubuntu" user):
#   sudo DOMAIN=sufian-planner.duckdns.org EMAIL=you@example.com BACKUP_BUCKET=my-bucket bash setup-server.sh planner_deploy.pub
#
#   DOMAIN         the web address that points at this server (needed for the HTTPS certificate)
#   EMAIL          your email: for Let's Encrypt certificate notices and as the push notification contact
#   BACKUP_BUCKET  optional: S3 bucket for nightly database backups (the server needs an IAM role that may write to it)
#   argument       the deploy public key file, so GitHub Actions can upload new versions
#
# What it sets up:
#   Node.js 24, Caddy (HTTPS), sqlite3, a 1 GB swap file, the "planner" service user, the "deploy" user,
#   /opt/planner (app versions), /var/lib/planner (database), /etc/planner.env (settings),
#   systemd services for the app and the nightly backup, and the Caddy site.

set -euo pipefail

DOMAIN="${DOMAIN:?Set DOMAIN, e.g. DOMAIN=sufian-planner.duckdns.org}"
EMAIL="${EMAIL:?Set EMAIL, e.g. EMAIL=you@example.com}"
BACKUP_BUCKET="${BACKUP_BUCKET:-}"
DEPLOY_KEY_FILE="${1:?Pass the deploy public key file, e.g. planner_deploy.pub}"

[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }
grep -q '^ssh-' "$DEPLOY_KEY_FILE" || { echo "$DEPLOY_KEY_FILE doesn't look like an SSH public key." >&2; exit 1; }

step() { printf '\n==> %s\n' "$*"; }
export DEBIAN_FRONTEND=noninteractive

step "Updating packages"
apt-get update -q
apt-get upgrade -yq
apt-get install -yq curl gnupg sqlite3 unzip debian-keyring debian-archive-keyring apt-transport-https

step "Installing Node.js 24"
if ! node --version 2>/dev/null | grep -q '^v24\.'; then
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -yq nodejs
fi
node --version

step "Installing Caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -yq caddy
fi
caddy version

if [[ -n "$BACKUP_BUCKET" ]] && ! command -v aws >/dev/null; then
  step "Installing the AWS CLI (for backups to S3)"
  arch="$(uname -m)" # aarch64 or x86_64
  tmp="$(mktemp -d)"
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${arch}.zip" -o "$tmp/awscli.zip"
  unzip -q "$tmp/awscli.zip" -d "$tmp"
  "$tmp/aws/install"
  rm -rf "$tmp"
fi

step "Adding a 1 GB swap file"
if ! swapon --show | grep -q /swapfile; then
  [[ -f /swapfile ]] || fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  if swapon /swapfile; then
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  else
    echo "Could not turn on swap here; continuing without it."
  fi
fi

step "Creating users and folders"
id planner >/dev/null 2>&1 || useradd --system --home-dir /var/lib/planner --shell /usr/sbin/nologin planner
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
install -d -m 700 -o planner -g planner /var/lib/planner /var/lib/planner/backups
install -d -m 755 -o deploy -g deploy /opt/planner /opt/planner/releases /opt/planner/incoming
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
install -m 600 -o deploy -g deploy "$DEPLOY_KEY_FILE" /home/deploy/.ssh/authorized_keys

# The deploy user may restart the app and nothing else as root.
cat > /etc/sudoers.d/planner-deploy <<'EOF'
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart planner
EOF
chmod 440 /etc/sudoers.d/planner-deploy
visudo -cf /etc/sudoers.d/planner-deploy

step "Writing settings to /etc/planner.env"
if [[ ! -f /etc/planner.env ]]; then
  cat > /etc/planner.env <<EOF
HOST=127.0.0.1
PORT=3000
DB_PATH=/var/lib/planner/planner.db
COOKIE_SECURE=true
TRUST_PROXY=true
VAPID_SUBJECT=mailto:${EMAIL}
BACKUP_BUCKET=${BACKUP_BUCKET}
PUBLIC_URL=https://${DOMAIN}
# Mail (Gmail and Outlook): see "Mail setup" in DEPLOY.md.
MAIL_TOKEN_KEY=$(openssl rand -base64 32)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
MS_CLIENT_ID=
MS_CLIENT_SECRET=
EOF
  chown root:planner /etc/planner.env
  chmod 640 /etc/planner.env
else
  echo "/etc/planner.env already exists; left as it is."
fi

step "Installing systemd services"
cat > /etc/systemd/system/planner.service <<'EOF'
[Unit]
Description=Planner
After=network-online.target
Wants=network-online.target

[Service]
User=planner
Group=planner
WorkingDirectory=/opt/planner/current/server
EnvironmentFile=/etc/planner.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning --max-old-space-size=192 src/index.js
Restart=always
RestartSec=3
# Only the database folder is writable; the rest of the system is read-only for the app.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/planner
MemoryMax=350M

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/planner-backup.service <<'EOF'
[Unit]
Description=Planner database backup
After=network-online.target

[Service]
Type=oneshot
User=planner
Group=planner
EnvironmentFile=/etc/planner.env
ExecStart=/bin/bash /opt/planner/current/deploy/backup.sh
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/planner
EOF

cat > /etc/systemd/system/planner-backup.timer <<'EOF'
[Unit]
Description=Nightly Planner backup (03:30 IST)

[Timer]
OnCalendar=*-*-* 03:30:00 Asia/Kolkata
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable planner.service planner-backup.timer
systemctl start planner-backup.timer

# A command to manage accounts: sudo planner-user add you@example.com
cat > /usr/local/bin/planner-user <<'EOF'
#!/usr/bin/env bash
# Manage Planner logins: planner-user add|passwd|list|remove <email> [--yes]
set -euo pipefail
cd /opt/planner/current/server
exec sudo -u planner bash -c 'set -a; . /etc/planner.env; set +a; exec node --disable-warning=ExperimentalWarning src/cli/users.js "$@"' _ "$@"
EOF
chmod 755 /usr/local/bin/planner-user

step "Configuring Caddy for https://${DOMAIN}"
cat > /etc/caddy/Caddyfile <<EOF
{
	email ${EMAIL}
}

${DOMAIN} {
	encode zstd gzip
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy 127.0.0.1:3000
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy || systemctl restart caddy

step "Done"
cat <<EOF

The server is ready. The app starts after the first deploy from GitHub.

Add these as GitHub secrets (repository → Settings → Secrets and variables → Actions):
  DEPLOY_HOST         ${DOMAIN}
  DEPLOY_KNOWN_HOSTS  (the line below)

${DOMAIN} $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)

EOF
