#!/usr/bin/env bash
# =============================================================================
# CloudMail Server — Ubuntu 22.04 / 24.04 Bare-Metal Installer
# Usage: sudo bash install-ubuntu.sh [domain] [admin-email]
# Example: sudo bash install-ubuntu.sh mail.example.com admin@example.com
# =============================================================================

set -euo pipefail

DOMAIN="${1:-mail.example.com}"
ADMIN_EMAIL="${2:-admin@example.com}"
APP_DIR="/opt/cloudmail"
APP_USER="cloudmail"
NODE_VERSION="20"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

info()    { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

[ "$(id -u)" = "0" ] || die "Must run as root"

info "Installing CloudMail on Ubuntu for domain: $DOMAIN"
info "Admin email: $ADMIN_EMAIL"

# ─── System update ───────────────────────────────────────────────────────────
info "Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq

# ─── Dependencies ─────────────────────────────────────────────────────────────
info "Installing system dependencies..."
apt-get install -y -qq \
    curl wget git openssl ca-certificates gnupg \
    postgresql postgresql-client \
    redis-server \
    nginx certbot python3-certbot-nginx \
    ufw logrotate

# ─── Node.js ──────────────────────────────────────────────────────────────────
info "Installing Node.js ${NODE_VERSION}..."
curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - >/dev/null 2>&1
apt-get install -y -qq nodejs

# ─── PostgreSQL ───────────────────────────────────────────────────────────────
info "Configuring PostgreSQL..."
systemctl enable --now postgresql

DB_PASSWORD=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)
DB_NAME="cloudmail"
DB_USER="cloudmail"

sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';" 2>/dev/null || true
sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};" 2>/dev/null || true
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};"

info "Database created: ${DB_NAME} / user: ${DB_USER}"

# ─── Redis ────────────────────────────────────────────────────────────────────
info "Configuring Redis..."
REDIS_PASSWORD=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 20)
sed -i "s/^# requirepass .*/requirepass ${REDIS_PASSWORD}/" /etc/redis/redis.conf
sed -i "s/^requirepass .*/requirepass ${REDIS_PASSWORD}/" /etc/redis/redis.conf || \
    echo "requirepass ${REDIS_PASSWORD}" >> /etc/redis/redis.conf
systemctl enable --now redis-server
systemctl restart redis-server

# ─── App User ─────────────────────────────────────────────────────────────────
info "Creating application user..."
id -u "${APP_USER}" &>/dev/null || useradd -r -s /bin/bash -d "${APP_DIR}" "${APP_USER}"

# ─── App Directory ────────────────────────────────────────────────────────────
info "Setting up application directory..."
mkdir -p "${APP_DIR}"
cp -r ./* "${APP_DIR}/" 2>/dev/null || { warn "No local files found, you can deploy manually to ${APP_DIR}"; }

mkdir -p /var/cloudmail/{messages,attachments} /var/log/cloudmail /etc/cloudmail/dkim /etc/ssl/cloudmail
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}" /var/cloudmail /var/log/cloudmail /etc/cloudmail /etc/ssl/cloudmail

# ─── JWT Secret ───────────────────────────────────────────────────────────────
JWT_SECRET=$(openssl rand -base64 48 | tr -dc 'a-zA-Z0-9' | head -c 64)
ADMIN_PASS=$(openssl rand -base64 12 | tr -dc 'a-zA-Z0-9' | head -c 16)

# ─── Environment File ─────────────────────────────────────────────────────────
info "Creating environment configuration..."
cat > "${APP_DIR}/.env" <<EOF
NODE_ENV=production
APP_NAME=CloudMail
APP_URL=https://${DOMAIN}
DB_HOST=localhost
DB_PORT=5432
DB_NAME=${DB_NAME}
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}
DB_SSL=false
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=${REDIS_PASSWORD}
TLS_KEY=/etc/ssl/cloudmail/mail.key
TLS_CERT=/etc/ssl/cloudmail/mail.crt
DKIM_SELECTOR=mail
DKIM_KEY_DIR=/etc/cloudmail/dkim
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRY=24h
ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_PASSWORD=${ADMIN_PASS}
MAIL_STORAGE_PATH=/var/cloudmail/messages
ATTACHMENT_STORAGE_PATH=/var/cloudmail/attachments
LOG_DIR=/var/log/cloudmail
LOG_LEVEL=info
SMTP_PORT=25
SMTP_SUBMISSION_PORT=587
SMTP_SECURE_PORT=465
IMAP_PORT=143
IMAPS_PORT=993
POP3_PORT=110
POP3S_PORT=995
HTTP_PORT=3000
MAX_MESSAGE_SIZE_MB=25
EOF
chmod 600 "${APP_DIR}/.env"
chown "${APP_USER}:${APP_USER}" "${APP_DIR}/.env"

# ─── Install Node modules ─────────────────────────────────────────────────────
info "Installing Node.js dependencies..."
cd "${APP_DIR}"
sudo -u "${APP_USER}" npm ci --omit=dev

# ─── SSL Certificate ──────────────────────────────────────────────────────────
info "Generating self-signed SSL certificate (replace with Let's Encrypt in production)..."
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout /etc/ssl/cloudmail/mail.key \
    -out /etc/ssl/cloudmail/mail.crt \
    -subj "/C=US/ST=State/L=City/O=CloudMail/CN=${DOMAIN}" 2>/dev/null
chown "${APP_USER}:${APP_USER}" /etc/ssl/cloudmail/mail.key /etc/ssl/cloudmail/mail.crt
chmod 640 /etc/ssl/cloudmail/mail.key

# ─── Systemd Service ──────────────────────────────────────────────────────────
info "Creating systemd service..."
cat > /etc/systemd/system/cloudmail.service <<EOF
[Unit]
Description=CloudMail Mail Server
Documentation=https://github.com/your-org/cloudmail
After=network.target postgresql.service redis-server.service
Requires=postgresql.service redis-server.service

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node src/server.js
ExecReload=/bin/kill -HUP \$MAINPID
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=${APP_DIR}/.env
StandardOutput=append:/var/log/cloudmail/stdout.log
StandardError=append:/var/log/cloudmail/stderr.log

# Security hardening
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/cloudmail /var/log/cloudmail /etc/cloudmail
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable cloudmail

# ─── Nginx Configuration ─────────────────────────────────────────────────────
info "Configuring Nginx..."
cat > /etc/nginx/sites-available/cloudmail <<EOF
server {
    listen 80;
    server_name ${DOMAIN};
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name ${DOMAIN};

    ssl_certificate     /etc/ssl/cloudmail/mail.crt;
    ssl_certificate_key /etc/ssl/cloudmail/mail.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    add_header Strict-Transport-Security "max-age=63072000" always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header X-Content-Type-Options nosniff always;

    client_max_body_size 30M;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
    }
}
EOF

ln -sf /etc/nginx/sites-available/cloudmail /etc/nginx/sites-enabled/cloudmail
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl enable --now nginx

# ─── Firewall ─────────────────────────────────────────────────────────────────
info "Configuring firewall..."
ufw --force enable
ufw allow ssh
ufw allow 25/tcp   comment "SMTP"
ufw allow 465/tcp  comment "SMTPS"
ufw allow 587/tcp  comment "SMTP Submission"
ufw allow 143/tcp  comment "IMAP"
ufw allow 993/tcp  comment "IMAPS"
ufw allow 110/tcp  comment "POP3"
ufw allow 995/tcp  comment "POP3S"
ufw allow 80/tcp   comment "HTTP"
ufw allow 443/tcp  comment "HTTPS"

# ─── Log Rotation ─────────────────────────────────────────────────────────────
cat > /etc/logrotate.d/cloudmail <<EOF
/var/log/cloudmail/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    sharedscripts
    postrotate
        systemctl reload cloudmail 2>/dev/null || true
    endscript
}
EOF

# ─── Start Services ───────────────────────────────────────────────────────────
info "Starting CloudMail..."
cd "${APP_DIR}"
sudo -u "${APP_USER}" node src/database/migrate.js
systemctl start cloudmail

# ─── Summary ─────────────────────────────────────────────────────────────────
cat <<SUMMARY

${GREEN}═══════════════════════════════════════════════════════════════${NC}
${GREEN}  CloudMail Installation Complete!${NC}
${GREEN}═══════════════════════════════════════════════════════════════${NC}

  Webmail:      https://${DOMAIN}/webmail
  Admin Panel:  https://${DOMAIN}/admin
  API:          https://${DOMAIN}/api

  Admin Login:
    Email:    ${ADMIN_EMAIL}
    Password: ${ADMIN_PASS}

  Database:
    Host:     localhost:5432
    Name:     ${DB_NAME}
    User:     ${DB_USER}
    Password: ${DB_PASSWORD}

  ${YELLOW}IMPORTANT NEXT STEPS:${NC}
  1. Configure DNS records (see docs/dns-setup.md)
  2. Get Let's Encrypt SSL: certbot --nginx -d ${DOMAIN}
  3. Add your first domain in the admin panel
  4. Generate DKIM keys via admin → DNS Wizard
  5. Set PTR (reverse DNS) record with your hosting provider

  Service management:
    systemctl status cloudmail
    journalctl -u cloudmail -f
    systemctl restart cloudmail

${GREEN}═══════════════════════════════════════════════════════════════${NC}
SUMMARY
