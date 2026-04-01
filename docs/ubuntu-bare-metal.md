# Ubuntu Bare-Metal Setup Guide

Complete guide for deploying CloudMail on Ubuntu 22.04 or 24.04 without Docker.

---

## Quick Install

```bash
# As root on a fresh Ubuntu 22.04/24.04 server:
wget -O install.sh https://raw.githubusercontent.com/your-org/cloudmail/main/scripts/install-ubuntu.sh
sudo bash install.sh mail.yourdomain.com admin@yourdomain.com
```

The installer handles everything automatically. For manual setup, follow the steps below.

---

## Manual Installation

### Prerequisites

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y curl wget git openssl ca-certificates gnupg
```

### 1. Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version  # Should show v20.x.x
```

### 2. PostgreSQL 16

```bash
sudo apt-get install -y postgresql postgresql-client

sudo systemctl enable --now postgresql

# Create database and user
sudo -u postgres psql <<EOF
CREATE USER cloudmail WITH PASSWORD 'your-strong-password';
CREATE DATABASE cloudmail OWNER cloudmail;
GRANT ALL PRIVILEGES ON DATABASE cloudmail TO cloudmail;
EOF
```

### 3. Redis

```bash
sudo apt-get install -y redis-server

# Set a password
sudo sed -i 's/^# requirepass .*/requirepass your-redis-password/' /etc/redis/redis.conf
sudo systemctl enable --now redis-server
sudo systemctl restart redis-server
```

### 4. Nginx

```bash
sudo apt-get install -y nginx

# Enable and test
sudo systemctl enable nginx
nginx -v
```

### 5. Deploy CloudMail

```bash
# Create app user
sudo useradd -r -s /bin/bash -d /opt/cloudmail cloudmail

# Create directories
sudo mkdir -p /opt/cloudmail
sudo mkdir -p /var/cloudmail/{messages,attachments}
sudo mkdir -p /var/log/cloudmail
sudo mkdir -p /etc/cloudmail/dkim
sudo mkdir -p /etc/ssl/cloudmail

# Copy application files
sudo cp -r /path/to/cloudmail/* /opt/cloudmail/

# Set ownership
sudo chown -R cloudmail:cloudmail /opt/cloudmail /var/cloudmail /var/log/cloudmail /etc/cloudmail /etc/ssl/cloudmail

# Install Node dependencies
cd /opt/cloudmail
sudo -u cloudmail npm ci --omit=dev
```

### 6. Environment Configuration

```bash
sudo -u cloudmail cp /opt/cloudmail/.env.example /opt/cloudmail/.env
sudo nano /opt/cloudmail/.env  # Or your preferred editor
```

Minimum required values:
```ini
NODE_ENV=production
DB_HOST=localhost
DB_PASSWORD=your-pg-password
REDIS_PASSWORD=your-redis-password
JWT_SECRET=$(openssl rand -base64 64)
ADMIN_EMAIL=admin@yourdomain.com
ADMIN_PASSWORD=your-admin-password
```

### 7. SSL Certificate

**Self-signed (for testing):**
```bash
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout /etc/ssl/cloudmail/mail.key \
    -out /etc/ssl/cloudmail/mail.crt \
    -subj "/CN=mail.yourdomain.com"

sudo chown cloudmail:cloudmail /etc/ssl/cloudmail/mail.key /etc/ssl/cloudmail/mail.crt
sudo chmod 640 /etc/ssl/cloudmail/mail.key
```

**Let's Encrypt (production):**
```bash
sudo apt-get install -y certbot
sudo bash /opt/cloudmail/scripts/setup-ssl.sh mail.yourdomain.com admin@yourdomain.com
```

### 8. Database Migration

```bash
cd /opt/cloudmail
sudo -u cloudmail node src/database/migrate.js
```

### 9. Systemd Service

```bash
sudo tee /etc/systemd/system/cloudmail.service > /dev/null <<EOF
[Unit]
Description=CloudMail Mail Server
After=network.target postgresql.service redis-server.service
Requires=postgresql.service redis-server.service

[Service]
Type=simple
User=cloudmail
Group=cloudmail
WorkingDirectory=/opt/cloudmail
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/cloudmail/.env
StandardOutput=append:/var/log/cloudmail/stdout.log
StandardError=append:/var/log/cloudmail/stderr.log
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/cloudmail /var/log/cloudmail /etc/cloudmail

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable cloudmail
sudo systemctl start cloudmail
sudo systemctl status cloudmail
```

### 10. Nginx Virtual Host

```bash
sudo tee /etc/nginx/sites-available/cloudmail > /dev/null <<'EOF'
server {
    listen 80;
    server_name mail.yourdomain.com;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name mail.yourdomain.com;

    ssl_certificate     /etc/ssl/cloudmail/mail.crt;
    ssl_certificate_key /etc/ssl/cloudmail/mail.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_cache   shared:SSL:10m;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
    add_header X-Frame-Options SAMEORIGIN;
    add_header X-Content-Type-Options nosniff;

    client_max_body_size 30M;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/cloudmail /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### 11. Firewall

```bash
sudo apt-get install -y ufw
sudo ufw --force enable
sudo ufw allow ssh
sudo ufw allow 25/tcp   # SMTP
sudo ufw allow 465/tcp  # SMTPS
sudo ufw allow 587/tcp  # SMTP Submission
sudo ufw allow 143/tcp  # IMAP
sudo ufw allow 993/tcp  # IMAPS
sudo ufw allow 110/tcp  # POP3
sudo ufw allow 995/tcp  # POP3S
sudo ufw allow 80/tcp   # HTTP
sudo ufw allow 443/tcp  # HTTPS
sudo ufw status
```

---

## Post-Installation

### Access the Admin Panel
```
https://mail.yourdomain.com/admin
```

### Add Your First Domain
1. Log in to admin panel
2. Go to Domains → Add Domain
3. Enter your domain name (e.g., `yourdomain.com`)
4. Check "Generate DKIM keys"
5. Click Add Domain

### Configure DNS
Go to Admin → DNS Wizard → select your domain → copy the records.

### Generate DKIM Keys (CLI)
```bash
cd /opt/cloudmail
sudo -u cloudmail node scripts/generate-dkim.js yourdomain.com mail
```

---

## Monitoring

```bash
# Service status
systemctl status cloudmail

# Live logs
journalctl -u cloudmail -f

# Application logs
tail -f /var/log/cloudmail/cloudmail-$(date +%Y-%m-%d).log

# Check mail ports are listening
ss -tlnp | grep -E '25|465|587|143|993|110|995'

# Test SMTP
telnet mail.yourdomain.com 25
# Expected: 220 CloudMail ESMTP ready

# Test IMAP
telnet mail.yourdomain.com 143
# Expected: * OK CloudMail IMAP4rev1 ready
```

---

## Updates

```bash
cd /opt/cloudmail
git pull origin main
sudo -u cloudmail npm ci --omit=dev
sudo -u cloudmail node src/database/migrate.js
sudo systemctl restart cloudmail
```

---

## Troubleshooting

### Port 25 already in use
```bash
# Check what's using port 25
ss -tlnp | grep :25

# If postfix/exim is running:
sudo systemctl stop postfix exim4 sendmail 2>/dev/null
sudo systemctl disable postfix exim4 sendmail 2>/dev/null
sudo systemctl restart cloudmail
```

### Database connection failed
```bash
# Test connection
sudo -u cloudmail psql -h localhost -U cloudmail -d cloudmail -c "SELECT version();"

# Check PostgreSQL is running
systemctl status postgresql

# Check auth method (must be md5 or scram-sha-256, not peer)
sudo nano /etc/postgresql/16/main/pg_hba.conf
# Ensure: local   cloudmail   cloudmail   md5
sudo systemctl reload postgresql
```

### Redis connection failed
```bash
redis-cli -a your-redis-password ping
# Should return: PONG
```

### Emails not delivered (outbound)
```bash
# Check if port 25 outbound is blocked by your provider
telnet smtp.gmail.com 25
# If it times out, your ISP/cloud blocks port 25
# Solution: Use an SMTP relay (Mailgun, SendGrid, AWS SES)
# Set SMTP_RELAY_HOST in .env
```
