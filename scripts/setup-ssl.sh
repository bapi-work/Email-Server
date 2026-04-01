#!/usr/bin/env bash
# Setup Let's Encrypt SSL certificate via Certbot
# Usage: sudo bash setup-ssl.sh mail.yourdomain.com admin@yourdomain.com

set -euo pipefail

DOMAIN="${1:?Usage: $0 <domain> <email>}"
EMAIL="${2:?Usage: $0 <domain> <email>}"
CERT_DIR="/etc/ssl/cloudmail"

mkdir -p "${CERT_DIR}"

# Stop nginx temporarily if running
systemctl stop nginx 2>/dev/null || true

# Get certificate
certbot certonly --standalone \
    -d "${DOMAIN}" \
    --email "${EMAIL}" \
    --agree-tos \
    --non-interactive

# Copy to cloudmail cert directory
cp "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" "${CERT_DIR}/mail.crt"
cp "/etc/letsencrypt/live/${DOMAIN}/privkey.pem" "${CERT_DIR}/mail.key"
chown cloudmail:cloudmail "${CERT_DIR}/mail.crt" "${CERT_DIR}/mail.key" 2>/dev/null || true
chmod 640 "${CERT_DIR}/mail.key"

# Setup auto-renewal hook
cat > /etc/letsencrypt/renewal-hooks/deploy/cloudmail.sh <<EOF
#!/bin/bash
cp /etc/letsencrypt/live/${DOMAIN}/fullchain.pem ${CERT_DIR}/mail.crt
cp /etc/letsencrypt/live/${DOMAIN}/privkey.pem ${CERT_DIR}/mail.key
chown cloudmail:cloudmail ${CERT_DIR}/mail.key ${CERT_DIR}/mail.crt
chmod 640 ${CERT_DIR}/mail.key
systemctl reload cloudmail
systemctl reload nginx
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/cloudmail.sh

# Restart services
systemctl start nginx 2>/dev/null || true
systemctl reload cloudmail 2>/dev/null || true

echo "SSL certificate installed for ${DOMAIN}"
echo "Auto-renewal configured via certbot timer"
systemctl status certbot.timer 2>/dev/null || certbot renew --dry-run
